import { useEffect, useState } from 'react';
import { Link, Navigate, useNavigate, useSearchParams } from 'react-router-dom';
import { api, qs } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { DataList, type Column } from '../../components/DataList';
import { Stat } from '../../components/charts';
import { Empty, ErrorBox, Loading, StatusBadge, formatDate, formatMoney, useToast, type Tone } from '../../components/ui';

/** A costing's statuses; none is in the shared lifecycle table as it stands. */
export const COSTING_TONES: Record<string, Tone> = { DRAFT: 'warn', PENDING_APPROVAL: 'info', FINAL: 'ok' };

export interface CostingRow {
  id: string;
  number: string;
  title: string;
  status: 'DRAFT' | 'PENDING_APPROVAL' | 'FINAL';
  contractValue: number;
  totalCost: number;
  grandTotal?: number;
  grossProfit: number;
  grossMarginPct: number;
  durationDays: number | null;
  systemUnit?: string | null;
  createdAt: string;
  customer: { id: string; name: string } | null;
  owner: { id: string; name: string };
  lineCount?: number;
  sectionCount?: number;
}

export function Costings() {
  const { can } = useAuth();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();

  // "Start costing" on a lead and Customer 360's "New costing" used to open a
  // dialog here as ?new=1&leadId=…&customerId=…. A new costing is a page now;
  // those links (and any bookmarked) land on it with the same preset.
  if (params.get('new') === '1') {
    return (
      <Navigate
        replace
        to={`/g-ops/costing/new${qs({ leadId: params.get('leadId') ?? undefined, customerId: params.get('customerId') ?? undefined })}`}
      />
    );
  }

  // ?view=templates lists the templates in place of the costings; it is in the
  // URL so a template opened and backed out of returns here.
  const view = params.get('view') === 'templates' ? 'templates' : 'list';
  const showView = (next: 'list' | 'templates') => {
    const p = new URLSearchParams(params);
    if (next === 'templates') p.set('view', 'templates');
    else p.delete('view');
    setParams(p, { replace: true });
  };

  const columns: Column<CostingRow>[] = [
    { key: 'number', label: 'Number', sortKey: 'number', width: '160px', render: (c) => <span className="mono">{c.number}</span> },
    {
      key: 'title',
      label: 'Costing',
      sortKey: 'title',
      render: (c) => (
        <div>
          <div>{c.title}</div>
          <div className="faint">
            {c.customer?.name ?? 'No customer linked'}
            {c.systemUnit ? ` · ${c.systemUnit}` : ''}
          </div>
        </div>
      ),
    },
    {
      key: 'contractValue',
      label: 'Contract value',
      sortKey: 'contractValue',
      align: 'right',
      render: (c) => <span className="mono">{formatMoney(c.contractValue)}</span>,
    },
    { key: 'totalCost', label: 'Budgeted cost', align: 'right', render: (c) => <span className="mono">{formatMoney(c.totalCost)}</span> },
    {
      key: 'margin',
      label: 'Margin',
      align: 'right',
      render: (c) => <MarginBadge pct={c.grossMarginPct} />,
    },
    { key: 'owner', label: 'Prepared by', render: (c) => c.owner.name },
    { key: 'createdAt', label: 'Date', sortKey: 'createdAt', render: (c) => formatDate(c.createdAt) },
    {
      key: 'status',
      label: 'Status',
      render: (c) => <StatusBadge status={c.status} extra={COSTING_TONES} />,
    },
  ];

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Costing</h1>
          <p>
            Where the contract amount comes from. The scope of work you enter here becomes the
            Schedule of Values — the same phases that progress reports, progress billing and the
            S-curve are measured against later.
          </p>
        </div>
      </div>

      <div className="row org-switch">
        <div className="scope-switch">
          <button type="button" className={view === 'list' ? 'active' : ''} aria-pressed={view === 'list'} onClick={() => showView('list')}>
            Costings
          </button>
          <button type="button" className={view === 'templates' ? 'active' : ''} aria-pressed={view === 'templates'} onClick={() => showView('templates')}>
            Templates
          </button>
        </div>
      </div>

      {view === 'templates' ? (
        <CostingTemplates />
      ) : (
        <>
          <CostingTiles scope={params.get('scope') === 'mine' ? 'mine' : 'all'} />
          <DataList<CostingRow>
            listKey="costings"
            endpoint="/costings"
            columns={columns}
            rowKey={(c) => c.id}
            scoped
            searchPlaceholder="Search number, title, customer, system…"
            onRowClick={(c) => navigate(`/g-ops/costing/${c.id}`)}
            emptyTitle="No costings yet"
            emptyHint="A costing is the first thing you make when a job looks real."
            filters={[
              {
                key: 'status',
                label: 'Status',
                options: [
                  { value: 'DRAFT', label: 'Draft' },
                  { value: 'PENDING_APPROVAL', label: 'Awaiting approval' },
                  { value: 'FINAL', label: 'Final' },
                ],
              },
              { key: 'finalised', label: 'Finalised', options: [{ value: 'this-month', label: 'This month' }] },
            ]}
            actions={
              can('gops.costing.create') ? (
                <Link to="/g-ops/costing/new" className="btn btn-primary btn-sm">
                  + New costing
                </Link>
              ) : null
            }
          />
        </>
      )}
    </div>
  );
}

/**
 * Where the costing work stands — moved here off the G-OPS funnel, where
 * "Being costed" counted leads and costings together. Each tile is the total
 * of the list it opens (`GET /costings/summary` runs the list's own query),
 * under the same Mine/All scope as the list.
 */
function CostingTiles({ scope }: { scope: 'mine' | 'all' }) {
  const [summary, setSummary] = useState<{ draft: number; pending: number; finalThisMonth: number } | null>(null);
  useEffect(() => {
    api
      .get<{ draft: number; pending: number; finalThisMonth: number }>(`/costings/summary${qs({ scope })}`)
      .then(setSummary)
      .catch(() => setSummary(null));
  }, [scope]);
  if (!summary) return null;
  const mine = scope === 'mine' ? '&scope=mine' : '';
  return (
    <div className="kpi-grid">
      <Stat
        label="Being costed"
        value={summary.draft}
        sub="drafts still being priced"
        icon="document"
        accent={summary.draft > 0 ? 'info' : 'quiet'}
        to={`/g-ops/costing?status=DRAFT${mine}`}
        more="Open them"
      />
      <Stat
        label="Awaiting approval"
        value={summary.pending}
        sub={summary.pending > 0 ? 'with the approver' : 'nothing waiting'}
        icon="clock"
        accent={summary.pending > 0 ? 'warn' : 'quiet'}
        to={`/g-ops/costing?status=PENDING_APPROVAL${mine}`}
        more="Open them"
      />
      <Stat
        label="Final this month"
        value={summary.finalThisMonth}
        sub="approved or marked final since the 1st"
        icon="check"
        accent={summary.finalThisMonth > 0 ? 'ok' : 'quiet'}
        to={`/g-ops/costing?finalised=this-month${mine}`}
        more="Open them"
      />
    </div>
  );
}

export function MarginBadge({ pct }: { pct: number }) {
  const value = `${(pct * 100).toFixed(1)}%`;
  // Below 10% a job is barely worth the risk; below zero it is losing money.
  const tone = pct < 0 ? 'danger' : pct < 0.1 ? 'warn' : 'ok';
  return <span className={`badge ${tone}`}>{value}</span>;
}

interface TemplateRow {
  id: string;
  name: string;
  description: string | null;
  withPrices: boolean;
  systemUnit: string | null;
  lineCount: number;
  sectionCount: number;
  taskCount: number;
  createdBy: { id: string; name: string };
  updatedAt: string;
  canEdit: boolean;
}

/**
 * The costing templates: a costing to start from — its lines, phases, tasks,
 * markup and terms. Saved from a costing's page or from the sheet ("Save as
 * template"); used from the sheet ("Start from a template") or from here.
 */
function CostingTemplates() {
  const { can } = useAuth();
  const toast = useToast();
  const [rows, setRows] = useState<TemplateRow[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [renaming, setRenaming] = useState<{ id: string; name: string; description: string } | null>(null);

  const load = () =>
    api
      .get<TemplateRow[]>('/costings/templates')
      .then(setRows)
      .catch(setError);
  useEffect(() => {
    void load();
  }, []);

  async function rename() {
    if (!renaming) return;
    try {
      await api.patch(`/costings/templates/${renaming.id}`, { name: renaming.name, description: renaming.description });
      toast('ok', 'Template renamed');
      setRenaming(null);
      void load();
    } catch (err) {
      setError(err);
    }
  }

  async function remove(t: TemplateRow) {
    if (!window.confirm(`Delete the template “${t.name}”? Costings already made from it are not affected.`)) return;
    try {
      await api.del(`/costings/templates/${t.id}`);
      toast('ok', 'Template deleted');
      void load();
    } catch (err) {
      setError(err);
    }
  }

  if (error && !rows) return <ErrorBox error={error} />;
  if (!rows) return <Loading />;

  return (
    <div className="card">
      <ErrorBox error={error} />
      {rows.length === 0 ? (
        <Empty
          title="No templates yet"
          hint="Open a costing you would build again and choose “Save as template” — or save one from the sheet while you type it."
        />
      ) : (
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>Template</th>
                <th className="right">Lines</th>
                <th className="right">Phases</th>
                <th>Prices</th>
                <th>Saved by</th>
                <th>Updated</th>
                <th>
                  <span className="visually-hidden">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((t) =>
                renaming?.id === t.id ? (
                  <tr key={t.id}>
                    <td colSpan={6}>
                      <div className="row cs-rename">
                        <input aria-label="Template name" value={renaming.name} maxLength={120} autoFocus onChange={(e) => setRenaming({ ...renaming, name: e.target.value })} />
                        <input
                          aria-label="Template description"
                          placeholder="Description"
                          value={renaming.description}
                          maxLength={500}
                          onChange={(e) => setRenaming({ ...renaming, description: e.target.value })}
                        />
                      </div>
                    </td>
                    <td>
                      <div className="row cs-row-actions">
                        <button type="button" className="btn btn-sm" onClick={() => setRenaming(null)}>
                          Cancel
                        </button>
                        <button type="button" className="btn btn-sm btn-primary" onClick={rename} disabled={renaming.name.trim().length < 2}>
                          Save
                        </button>
                      </div>
                    </td>
                  </tr>
                ) : (
                  <tr key={t.id}>
                    <td>
                      <div>
                        <strong>{t.name}</strong>
                      </div>
                      <div className="faint">{[t.systemUnit, t.description].filter(Boolean).join(' · ') || '—'}</div>
                    </td>
                    <td className="right mono">{t.lineCount}</td>
                    <td className="right mono">
                      {t.sectionCount}
                      {t.taskCount ? <span className="faint"> · {t.taskCount} tasks</span> : null}
                    </td>
                    <td>{t.withPrices ? 'With unit costs' : 'Quantities only'}</td>
                    <td>{t.createdBy.name}</td>
                    <td>{formatDate(t.updatedAt)}</td>
                    <td>
                      <div className="row cs-row-actions">
                        {can('gops.costing.create') && (
                          <Link to={`/g-ops/costing/new?template=${t.id}`} className="btn btn-sm btn-primary">
                            Start costing
                          </Link>
                        )}
                        {t.canEdit && (
                          <>
                            <button type="button" className="btn btn-sm" onClick={() => setRenaming({ id: t.id, name: t.name, description: t.description ?? '' })}>
                              Rename
                            </button>
                            <button type="button" className="btn btn-sm btn-danger" onClick={() => remove(t)}>
                              Delete
                            </button>
                          </>
                        )}
                      </div>
                    </td>
                  </tr>
                ),
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
