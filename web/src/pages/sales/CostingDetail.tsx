import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api, openPdf } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import {
  Empty,
  ErrorBox,
  Field,
  Loading,
  Modal,
  StatusBadge,
  formatMoney,
  useToast,
} from '../../components/ui';
import { COSTING_TONES, CostingForm, MarginBadge, type CostingRow } from './Costings';

/**
 * The costing workspace.
 *
 * Two halves that must agree: what the job COSTS (lines, in the five buckets)
 * and what it is SOLD as, broken into scope sections. The scope sections are
 * the Schedule of Values, so their total has to equal the contract value —
 * the page says so plainly rather than letting it drift.
 */

interface Ref {
  id: string;
  name: string;
  code?: string;
}

interface CostLine {
  id: string;
  description: string;
  quantity: number;
  unit: string;
  unitCost: number;
  amount: number;
  sortOrder: number;
  costCategory: { id: string; code: string; name: string; sortOrder: number };
  item: Ref | null;
}

interface ScopeTask {
  id: string;
  name: string;
  durationDays: number;
}

interface ScopeSection {
  id: string;
  kind: 'MAIN_WORK' | 'TESTING_COMMISSIONING' | 'TURNOVER' | 'OTHER';
  name: string;
  description: string | null;
  durationDays: number;
  value: number;
  sortOrder: number;
  tasks: ScopeTask[];
}

interface CostingDetail extends CostingRow {
  markupPct: number;
  discountAmount: number;
  notes: string | null;
  terms: string | null;
  canEdit: boolean;
  scopeTotal: number;
  lines: CostLine[];
  scopeSections: ScopeSection[];
  site: Ref | null;
  /** The lead this costing was started from, when it was. */
  lead: { id: string; number: string; companyName: string; status: string } | null;
  quotationRevisions: {
    id: string;
    revision: number;
    status: string;
    quotation: { id: string; number: string; subject: string };
  }[];
  /** The jobs built on this costing — a project or a service contract. */
  jobs: { id: string; number: string; name: string; status: string; type: string }[];
}

const KINDS = [
  { value: 'MAIN_WORK', label: 'Main work' },
  { value: 'TESTING_COMMISSIONING', label: 'Testing & commissioning' },
  { value: 'TURNOVER', label: 'Turnover' },
  { value: 'OTHER', label: 'Other' },
];

export function CostingDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { can } = useAuth();
  const toast = useToast();
  const [params] = useSearchParams();

  const [costing, setCosting] = useState<CostingDetail | null>(null);
  const [categories, setCategories] = useState<Ref[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [tab, setTab] = useState<'cost' | 'scope' | 'summary'>('cost');
  const [editing, setEditing] = useState(false);
  const [duplicating, setDuplicating] = useState(false);
  const [lineModal, setLineModal] = useState<CostLine | 'new' | null>(null);
  const [sectionModal, setSectionModal] = useState<ScopeSection | 'new' | null>(null);

  // A renewal arrives as ?renewFrom=<contract id>: the Contracts screen has
  // just duplicated the old contract's costing and sent the user here to
  // reprice it. The banner names the old contract when it can be read.
  const renewFrom = params.get('renewFrom');
  const [renewedContract, setRenewedContract] = useState<{ id: string; number: string } | null>(null);
  useEffect(() => {
    if (!renewFrom) return;
    api
      .get<{ id: string; number: string }>(`/service-contracts/${renewFrom}`)
      .then((c) => setRenewedContract({ id: c.id, number: c.number }))
      .catch(() => setRenewedContract(null));
  }, [renewFrom]);

  const load = useCallback(async () => {
    if (!id) return;
    try {
      setCosting(await api.get<CostingDetail>(`/costings/${id}`));
      setError(null);
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    void load();
    api.get<Ref[]>('/reference/cost-categories').then(setCategories).catch(() => {});
  }, [load]);

  if (loading) return <Loading />;
  if (!costing) return <ErrorBox error={error ?? new Error('Costing not found')} />;

  const editable = costing.canEdit && costing.status === 'DRAFT';

  async function setStatus(status: 'DRAFT' | 'FINAL') {
    if (!costing) return;
    try {
      await api.patch(`/costings/${costing.id}`, { status });
      toast('ok', status === 'FINAL' ? 'Costing marked final' : 'Costing reopened');
      await load();
    } catch (err) {
      setError(err);
    }
  }

  async function distribute() {
    if (!costing) return;
    try {
      setCosting(await api.post<CostingDetail>(`/costings/${costing.id}/sections/distribute`));
      toast('ok', 'Contract value spread across the scope sections');
    } catch (err) {
      setError(err);
    }
  }

  function printPdf() {
    openPdf(`/api/costings/${costing!.id}/pdf`, () => toast('error', 'Could not render the costing sheet'));
  }

  /** A fresh draft copy under a new number, then straight to it. */
  async function duplicate() {
    if (!costing) return;
    setDuplicating(true);
    try {
      const copy = await api.post<{ id: string; number: string }>(`/costings/${costing.id}/duplicate`);
      toast('ok', `Copied as ${copy.number}`);
      navigate(`/g-ops/costing/${copy.id}`);
    } catch (err) {
      setError(err);
    } finally {
      setDuplicating(false);
    }
  }

  async function remove() {
    if (!costing) return;
    try {
      await api.del(`/costings/${costing.id}`);
      toast('ok', 'Costing deleted');
      navigate('/g-ops/costing');
    } catch (err) {
      setError(err);
    }
  }

  // Cost lines grouped into the five buckets, in the model's order.
  const buckets = new Map<string, { category: CostLine['costCategory']; lines: CostLine[]; total: number }>();
  for (const line of costing.lines) {
    const b = buckets.get(line.costCategory.id) ?? { category: line.costCategory, lines: [], total: 0 };
    b.lines.push(line);
    b.total += line.amount;
    buckets.set(line.costCategory.id, b);
  }
  const ordered = [...buckets.values()].sort((a, b) => a.category.sortOrder - b.category.sortOrder);

  const scopeDrift = Math.round((costing.scopeTotal - costing.contractValue) * 100) / 100;

  // The next-step links. A project is built on a FINAL costing (the API
  // refuses a draft), and a service contract is a job of that type — so the
  // renewal path is the project path with the type and the old contract on it.
  const isFinal = costing.status === 'FINAL';
  const projectHref = renewFrom
    ? `/g-ops/projects?new=1&costingId=${costing.id}&type=SERVICE_CONTRACT&renewFrom=${renewFrom}`
    : `/g-ops/projects?new=1&costingId=${costing.id}`;
  const quotationHref = `/g-ops/quotations/new?costingId=${costing.id}`;
  const canCreateProject = can('gops.projects.create');
  const canCreateQuotation = can('gops.quotations.create');

  return (
    <div>
      <div className="breadcrumb">
        <Link to="/g-ops/costing">Costing</Link>
        <span className="sep">›</span>
        <span className="mono">{costing.number}</span>
        {costing.quotationRevisions.length > 0 && (
          <>
            <span className="sep">›</span>
            {costing.quotationRevisions.map((r) => (
              <Link key={r.id} to={`/g-ops/quotations/${r.quotation.id}`}>
                {r.quotation.number} R{r.revision}
              </Link>
            ))}
          </>
        )}
      </div>

      <div className="page-head">
        <div>
          <h1>{costing.title}</h1>
          <p>
            {costing.customer ? (
              can('gops.customers.view_all') ? (
                <Link to={`/g-ops/customers/${costing.customer.id}`}>{costing.customer.name}</Link>
              ) : (
                costing.customer.name
              )
            ) : (
              'No customer linked'
            )}
            {costing.site ? ` · ${costing.site.name}` : ''} · prepared by {costing.owner.name}
            {costing.lead && (
              <>
                {' · from lead '}
                <Link to={`/g-ops/leads/${costing.lead.id}`} className="mono">
                  {costing.lead.number}
                </Link>
              </>
            )}
            <span style={{ marginLeft: 'var(--s-2)' }}>
              <StatusBadge status={costing.status} extra={COSTING_TONES} />
            </span>
          </p>
        </div>
        <div className="row">
          <button className="btn" onClick={printPdf}>
            Print
          </button>
          {can('gops.costing.create') && (
            <button className="btn" onClick={duplicate} disabled={duplicating}>
              {duplicating ? 'Copying…' : 'Duplicate'}
            </button>
          )}
          {costing.canEdit && costing.status === 'DRAFT' && (
            <>
              <button className="btn" onClick={() => setEditing(true)}>
                Modify
              </button>
              <button className="btn btn-ok" onClick={() => setStatus('FINAL')}>
                Mark final
              </button>
            </>
          )}
          {costing.canEdit && costing.status === 'FINAL' && (
            <button className="btn btn-danger" onClick={() => setStatus('DRAFT')}>
              Reopen
            </button>
          )}
          {costing.canEdit && can('gops.costing.delete') && costing.status === 'DRAFT' && (
            <button className="btn btn-danger" onClick={remove}>
              Delete
            </button>
          )}
        </div>
      </div>

      <ErrorBox error={error} />

      {renewFrom && (
        <div className="alert warn">
          Renewal of{' '}
          {renewedContract ? (
            <Link to={`/g-ops/service-contracts/${renewedContract.id}`} className="mono">
              {renewedContract.number}
            </Link>
          ) : (
            'the previous service contract'
          )}{' '}
          — copied at last year's prices. Reprice the lines, mark the costing final, then{' '}
          {isFinal && canCreateProject ? (
            <Link to={projectHref} className="btn btn-primary btn-sm">
              Create service contract
            </Link>
          ) : (
            <strong>Create service contract</strong>
          )}
          .
        </div>
      )}

      {/* The headline numbers, always visible — this is what the page is for. */}
      <div className="grid grid-4" style={{ marginBottom: 'var(--s-5)' }}>
        <Stat label="Estimated cost" value={formatMoney(costing.totalCost)} />
        <Stat label="Contract value" value={formatMoney(costing.contractValue)} accent />
        <Stat label="Gross profit" value={formatMoney(costing.grossProfit)} />
        <Stat label="Gross margin" value={<MarginBadge pct={costing.grossMarginPct} />} />
      </div>

      <div className="scope-switch" style={{ marginBottom: 'var(--s-4)' }}>
        <button className={tab === 'cost' ? 'active' : ''} onClick={() => setTab('cost')}>
          Cost ({costing.lines.length})
        </button>
        <button className={tab === 'scope' ? 'active' : ''} onClick={() => setTab('scope')}>
          Scope of work ({costing.scopeSections.length})
        </button>
        <button className={tab === 'summary' ? 'active' : ''} onClick={() => setTab('summary')}>
          How the price is built
        </button>
      </div>

      {tab === 'cost' && (
        <div className="card">
          <div className="row" style={{ justifyContent: 'space-between', marginBottom: 'var(--s-3)' }}>
            <h3 className="card-title" style={{ margin: 0 }}>
              Estimated cost
            </h3>
            {editable && (
              <button className="btn btn-primary btn-sm" onClick={() => setLineModal('new')}>
                + Add cost line
              </button>
            )}
          </div>

          {costing.lines.length === 0 ? (
            <Empty
              title="No cost lines yet"
              hint="Add what the job will cost you, in the five buckets: materials, equipment, labour, subcontractor, indirect."
            />
          ) : (
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    <th>Description</th>
                    <th className="right">Qty</th>
                    <th>Unit</th>
                    <th className="right">Unit cost</th>
                    <th className="right">Amount</th>
                    {editable && <th />}
                  </tr>
                </thead>
                <tbody>
                  {ordered.map((bucket) => (
                    <>
                      <tr key={bucket.category.id} style={{ background: 'var(--surface-2)' }}>
                        <td colSpan={editable ? 6 : 5}>
                          <strong style={{ color: 'var(--neon-dim)' }}>{bucket.category.name}</strong>
                          <span className="faint" style={{ marginLeft: 'var(--s-3)' }}>
                            {formatMoney(bucket.total)}
                          </span>
                        </td>
                      </tr>
                      {bucket.lines.map((line) => (
                        <tr key={line.id}>
                          <td style={{ paddingLeft: 'var(--s-6)' }}>
                            {line.description}
                            {line.item && <div className="faint mono">{line.item.code}</div>}
                          </td>
                          <td className="right mono">{line.quantity}</td>
                          <td>{line.unit}</td>
                          <td className="right mono">{formatMoney(line.unitCost)}</td>
                          <td className="right mono">{formatMoney(line.amount)}</td>
                          {editable && (
                            <td>
                              <button className="btn btn-sm" onClick={() => setLineModal(line)}>
                                Modify
                              </button>
                            </td>
                          )}
                        </tr>
                      ))}
                    </>
                  ))}
                  <tr>
                    <td colSpan={4} className="right">
                      <strong>TOTAL ESTIMATED COST</strong>
                    </td>
                    <td className="right mono">
                      <strong>{formatMoney(costing.totalCost)}</strong>
                    </td>
                    {editable && <td />}
                  </tr>
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {tab === 'scope' && (
        <div className="card">
          <div className="row" style={{ justifyContent: 'space-between', marginBottom: 'var(--s-3)' }}>
            <h3 className="card-title" style={{ margin: 0 }}>
              Scope of work — schedule of values
            </h3>
            {editable && (
              <div className="row">
                <button className="btn btn-sm" onClick={distribute} disabled={!costing.scopeSections.length}>
                  Spread contract value
                </button>
                <button className="btn btn-primary btn-sm" onClick={() => setSectionModal('new')}>
                  + Add section
                </button>
              </div>
            )}
          </div>

          <p className="muted" style={{ marginTop: 0, fontSize: 'var(--fs-md)' }}>
            These sections are billed against. Their total must equal the contract value, or
            progress billing will not add up.
          </p>

          {costing.scopeSections.length === 0 ? (
            <Empty
              title="No scope sections yet"
              hint="Typically: main work, testing & commissioning, turnover."
            />
          ) : (
            <>
              <div className="table-wrap">
                <table className="data">
                  <thead>
                    <tr>
                      <th>#</th>
                      <th>Scope</th>
                      <th>Type</th>
                      <th className="right">Duration</th>
                      <th className="right">Value</th>
                      <th className="right">% of contract</th>
                      {editable && <th />}
                    </tr>
                  </thead>
                  <tbody>
                    {costing.scopeSections.map((s, i) => (
                      <tr key={s.id}>
                        <td className="mono">{i + 1}</td>
                        <td>
                          <div>{s.name}</div>
                          {s.description && <div className="faint">{s.description}</div>}
                          {s.tasks.length > 0 && (
                            <div className="faint" style={{ marginTop: 'var(--s-1)' }}>
                              {s.tasks.map((t) => `· ${t.name}`).join('  ')}
                            </div>
                          )}
                        </td>
                        <td className="muted">{KINDS.find((k) => k.value === s.kind)?.label}</td>
                        <td className="right mono">{s.durationDays} d</td>
                        <td className="right mono">{formatMoney(s.value)}</td>
                        <td className="right mono faint">
                          {costing.contractValue > 0
                            ? `${((s.value / costing.contractValue) * 100).toFixed(1)}%`
                            : '—'}
                        </td>
                        {editable && (
                          <td>
                            <button className="btn btn-sm" onClick={() => setSectionModal(s)}>
                              Modify
                            </button>
                          </td>
                        )}
                      </tr>
                    ))}
                    <tr>
                      <td colSpan={4} className="right">
                        <strong>TOTAL</strong>
                      </td>
                      <td className="right mono">
                        <strong>{formatMoney(costing.scopeTotal)}</strong>
                      </td>
                      <td colSpan={editable ? 2 : 1} />
                    </tr>
                  </tbody>
                </table>
              </div>

              {Math.abs(scopeDrift) > 0.009 && (
                <div className="alert error" style={{ marginTop: 'var(--s-3)', marginBottom: 0 }}>
                  The scope sections total {formatMoney(costing.scopeTotal)}, but the contract value
                  is {formatMoney(costing.contractValue)} —{' '}
                  {scopeDrift > 0 ? 'over' : 'under'} by {formatMoney(Math.abs(scopeDrift))}.
                  {editable && ' Use “Spread contract value” to reconcile it.'}
                </div>
              )}
              {Math.abs(scopeDrift) <= 0.009 && costing.scopeSections.length > 0 && (
                <div className="alert ok" style={{ marginTop: 'var(--s-3)', marginBottom: 0 }}>
                  The schedule of values matches the contract value. This is what progress billing
                  will bill against.
                </div>
              )}
            </>
          )}
        </div>
      )}

      {tab === 'summary' && (
        <div className="grid grid-2">
          <div className="card">
            <h3 className="card-title">How the contract amount is reached</h3>
            <table className="data">
              <tbody>
                <SummaryRow label="Total estimated cost" value={formatMoney(costing.totalCost)} />
                <SummaryRow
                  label={`Markup (${(costing.markupPct * 100).toFixed(2)}%)`}
                  value={formatMoney(costing.totalCost * costing.markupPct)}
                />
                <SummaryRow label="Less discount" value={formatMoney(-costing.discountAmount)} />
                <SummaryRow label="CONTRACT AMOUNT" value={formatMoney(costing.contractValue)} strong />
                <SummaryRow label="Gross profit" value={formatMoney(costing.grossProfit)} />
                <SummaryRow
                  label="Gross margin"
                  value={`${(costing.grossMarginPct * 100).toFixed(2)}%`}
                />
              </tbody>
            </table>
            <p className="faint" style={{ fontSize: 'var(--fs-sm)', marginBottom: 0 }}>
              Margin is profit over the contract value, not over cost — the two are different
              numbers and only this one is what the business calls margin.
            </p>
          </div>

          <div className="card">
            <h3 className="card-title">Where this goes next</h3>

            <div className="section-label">QUOTATIONS</div>
            {costing.quotationRevisions.length === 0 ? (
              <p className="muted" style={{ marginTop: 0 }}>
                Not yet attached to a quotation. The scope sections can fill the quotation's lines
                in one click.
              </p>
            ) : (
              <div className="stack" style={{ marginBottom: 'var(--s-3)' }}>
                {costing.quotationRevisions.map((r) => (
                  <Link key={r.id} to={`/g-ops/quotations/${r.quotation.id}`} className="row">
                    <span className="mono">
                      {r.quotation.number} R{r.revision}
                    </span>
                    <StatusBadge status={r.status} />
                    <span className="muted">{r.quotation.subject}</span>
                  </Link>
                ))}
              </div>
            )}
            {canCreateQuotation && (
              <Link to={quotationHref} className="btn btn-sm">
                Create quotation
              </Link>
            )}

            <hr className="rule" />
            <div className="section-label">PROJECTS</div>
            {costing.jobs.length === 0 ? (
              <p className="muted" style={{ marginTop: 0 }}>
                {isFinal
                  ? 'No project built on this costing yet.'
                  : 'A project is built on a final costing — mark this one final first.'}
              </p>
            ) : (
              <div className="stack" style={{ marginBottom: 'var(--s-3)' }}>
                {costing.jobs.map((j) => (
                  <Link key={j.id} to={`/g-ops/projects/${j.id}`} className="row">
                    <span className="mono">{j.number}</span>
                    <StatusBadge status={j.status} />
                    <span className="muted">
                      {j.name}
                      {j.type === 'SERVICE_CONTRACT' ? ' · service contract' : ''}
                    </span>
                  </Link>
                ))}
              </div>
            )}
            {isFinal && canCreateProject && (
              <Link to={projectHref} className="btn btn-sm">
                {renewFrom ? 'Create service contract' : 'Create project'}
              </Link>
            )}

            {costing.notes && (
              <>
                <hr className="rule" />
                <div className="section-label">NOTES</div>
                <div style={{ whiteSpace: 'pre-wrap' }}>{costing.notes}</div>
              </>
            )}
          </div>
        </div>
      )}

      {editing && (
        <CostingForm
          costing={costing}
          onClose={() => setEditing(false)}
          onSaved={() => {
            setEditing(false);
            void load();
          }}
        />
      )}

      {lineModal && (
        <LineModal
          costingId={costing.id}
          line={lineModal === 'new' ? null : lineModal}
          categories={categories}
          onClose={() => setLineModal(null)}
          onSaved={() => {
            setLineModal(null);
            void load();
          }}
        />
      )}

      {sectionModal && (
        <SectionModal
          costingId={costing.id}
          section={sectionModal === 'new' ? null : sectionModal}
          onClose={() => setSectionModal(null)}
          onSaved={() => {
            setSectionModal(null);
            void load();
          }}
        />
      )}
    </div>
  );
}

function Stat({ label, value, accent }: { label: string; value: React.ReactNode; accent?: boolean }) {
  return (
    <div className="card">
      <div className="faint" style={{ fontSize: 'var(--fs-xs)', letterSpacing: '0.08em' }}>
        {label.toUpperCase()}
      </div>
      <div
        style={{
          fontSize: 'var(--fs-xl)',
          marginTop: 'var(--s-2)',
          fontWeight: 600,
          color: accent ? 'var(--neon)' : 'var(--text)',
        }}
      >
        {value}
      </div>
    </div>
  );
}

function SummaryRow({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <tr>
      <td>{strong ? <strong>{label}</strong> : label}</td>
      <td className="right mono">{strong ? <strong>{value}</strong> : value}</td>
    </tr>
  );
}

// ── Modals ───────────────────────────────────────────────────────────────────

function LineModal({
  costingId,
  line,
  categories,
  onClose,
  onSaved,
}: {
  costingId: string;
  line: CostLine | null;
  categories: Ref[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [items, setItems] = useState<{ id: string; code: string; name: string; unit: string; standardCost: string | null }[]>([]);
  const [form, setForm] = useState({
    costCategoryId: line?.costCategory.id ?? categories[0]?.id ?? '',
    itemId: line?.item?.id ?? '',
    description: line?.description ?? '',
    quantity: line?.quantity?.toString() ?? '1',
    unit: line?.unit ?? 'pcs',
    unitCost: line?.unitCost?.toString() ?? '',
  });

  useEffect(() => {
    api.get<typeof items>('/items/lookup').then(setItems).catch(() => {});
  }, []);

  const amount = (Number(form.quantity) || 0) * (Number(form.unitCost) || 0);

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const payload = {
        costCategoryId: form.costCategoryId,
        itemId: form.itemId || null,
        description: form.description,
        quantity: Number(form.quantity),
        unit: form.unit,
        unitCost: Number(form.unitCost),
      };
      if (line) await api.patch(`/costings/${costingId}/lines/${line.id}`, payload);
      else await api.post(`/costings/${costingId}/lines`, payload);
      onSaved();
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  }

  async function remove() {
    if (!line) return;
    setBusy(true);
    try {
      await api.del(`/costings/${costingId}/lines/${line.id}`);
      onSaved();
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  }

  /** Picking an item fills the description, unit and cost from the master. */
  function pickItem(itemId: string) {
    const item = items.find((i) => i.id === itemId);
    setForm((f) => ({
      ...f,
      itemId,
      description: item && !f.description ? item.name : f.description,
      unit: item?.unit ?? f.unit,
      unitCost: item?.standardCost != null && !f.unitCost ? String(item.standardCost) : f.unitCost,
    }));
  }

  return (
    <Modal
      title={line ? 'Modify cost line' : 'Add cost line'}
      onClose={onClose}
      footer={
        <>
          {line && (
            <button className="btn btn-danger" onClick={remove} disabled={busy}>
              Remove
            </button>
          )}
          <div style={{ flex: 1 }} />
          <button className="btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button className="btn btn-primary" onClick={save} disabled={busy || !form.description}>
            {busy ? 'Saving…' : 'Save'}
          </button>
        </>
      }
    >
      <ErrorBox error={error} />
      <Field label="Cost category" hint="Which bucket this lands in, on the budget and the cost ledger">
        <select
          value={form.costCategoryId}
          onChange={(e) => setForm({ ...form, costCategoryId: e.target.value })}
        >
          {categories.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Item" hint="Optional — picking one fills the description, unit and cost">
        <select value={form.itemId} onChange={(e) => pickItem(e.target.value)}>
          <option value="">— not from the item master —</option>
          {items.map((i) => (
            <option key={i.id} value={i.id}>
              {i.code} — {i.name}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Description">
        <input
          value={form.description}
          onChange={(e) => setForm({ ...form, description: e.target.value })}
        />
      </Field>
      <div className="grid grid-3">
        <Field label="Quantity">
          <input
            type="number"
            step="0.001"
            value={form.quantity}
            onChange={(e) => setForm({ ...form, quantity: e.target.value })}
          />
        </Field>
        <Field label="Unit">
          <input value={form.unit} onChange={(e) => setForm({ ...form, unit: e.target.value })} />
        </Field>
        <Field label="Unit cost">
          <input
            type="number"
            step="0.01"
            value={form.unitCost}
            onChange={(e) => setForm({ ...form, unitCost: e.target.value })}
          />
        </Field>
      </div>
      <div className="alert info" style={{ marginBottom: 0 }}>
        Line amount: <strong>{formatMoney(amount)}</strong>
      </div>
    </Modal>
  );
}

function SectionModal({
  costingId,
  section,
  onClose,
  onSaved,
}: {
  costingId: string;
  section: ScopeSection | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [taskName, setTaskName] = useState('');
  const [form, setForm] = useState({
    kind: section?.kind ?? 'MAIN_WORK',
    name: section?.name ?? '',
    description: section?.description ?? '',
    durationDays: section?.durationDays?.toString() ?? '0',
    value: section?.value?.toString() ?? '0',
  });

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const payload = {
        kind: form.kind,
        name: form.name,
        description: form.description || null,
        durationDays: Number(form.durationDays),
        value: Number(form.value),
      };
      if (section) await api.patch(`/costings/${costingId}/sections/${section.id}`, payload);
      else await api.post(`/costings/${costingId}/sections`, payload);
      onSaved();
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  }

  async function remove() {
    if (!section) return;
    setBusy(true);
    try {
      await api.del(`/costings/${costingId}/sections/${section.id}`);
      onSaved();
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  }

  async function addTask() {
    if (!section || !taskName) return;
    try {
      await api.post(`/costings/${costingId}/sections/${section.id}/tasks`, {
        name: taskName,
        durationDays: 0,
      });
      setTaskName('');
      onSaved();
    } catch (err) {
      setError(err);
    }
  }

  async function removeTask(taskId: string) {
    if (!section) return;
    try {
      await api.del(`/costings/${costingId}/sections/${section.id}/tasks/${taskId}`);
      onSaved();
    } catch (err) {
      setError(err);
    }
  }

  return (
    <Modal
      title={section ? `Modify ${section.name}` : 'Add scope section'}
      onClose={onClose}
      footer={
        <>
          {section && (
            <button className="btn btn-danger" onClick={remove} disabled={busy}>
              Remove
            </button>
          )}
          <div style={{ flex: 1 }} />
          <button className="btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button className="btn btn-primary" onClick={save} disabled={busy || form.name.length < 2}>
            {busy ? 'Saving…' : 'Save'}
          </button>
        </>
      }
    >
      <ErrorBox error={error} />
      <Field label="Type">
        <select value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value as ScopeSection['kind'] })}>
          {KINDS.map((k) => (
            <option key={k.value} value={k.value}>
              {k.label}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Name" hint="e.g. Fabrication and controller assembly">
        <input value={form.name} autoFocus onChange={(e) => setForm({ ...form, name: e.target.value })} />
      </Field>
      <Field label="Description">
        <textarea
          value={form.description}
          onChange={(e) => setForm({ ...form, description: e.target.value })}
        />
      </Field>
      <div className="grid grid-2">
        <Field label="Duration (days)" hint="Drives the planned S-curve in Phase 4">
          <input
            type="number"
            value={form.durationDays}
            onChange={(e) => setForm({ ...form, durationDays: e.target.value })}
          />
        </Field>
        <Field label="Value" hint="This section's share of the contract value">
          <input
            type="number"
            step="0.01"
            value={form.value}
            onChange={(e) => setForm({ ...form, value: e.target.value })}
          />
        </Field>
      </div>

      {section && (
        <>
          <hr className="rule" />
          <div className="faint" style={{ fontSize: 'var(--fs-xs)', marginBottom: 'var(--s-2)' }}>
            TASKS
          </div>
          {section.tasks.length === 0 ? (
            <p className="muted" style={{ marginTop: 0 }}>
              No tasks yet.
            </p>
          ) : (
            <div className="stack" style={{ marginBottom: 'var(--s-3)' }}>
              {section.tasks.map((t) => (
                <div key={t.id} className="row" style={{ justifyContent: 'space-between' }}>
                  <span>{t.name}</span>
                  <button className="btn btn-ghost btn-sm" onClick={() => removeTask(t.id)}>
                    ✕
                  </button>
                </div>
              ))}
            </div>
          )}
          <div className="row">
            <input
              value={taskName}
              placeholder="Add a task…"
              onChange={(e) => setTaskName(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && addTask()}
            />
            <button className="btn btn-sm" onClick={addTask} disabled={!taskName}>
              Add
            </button>
          </div>
        </>
      )}
    </Modal>
  );
}
