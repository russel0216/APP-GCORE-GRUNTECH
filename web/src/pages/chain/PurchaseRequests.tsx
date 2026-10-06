import { useCallback, useEffect, useState } from 'react';
import { Link, useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api, openPdf } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { DataList, type Column } from '../../components/DataList';
import {
  humanise,
  statusTone,
  StatusBadge,
  Empty,
  ErrorBox,
  Field,
  Loading,
  Modal,
  formatDate,
  formatMoney,
  useToast,
} from '../../components/ui';
import { DocumentApproval } from '../../components/ApprovalStepper';
import { RecordHeader } from '../../components/RecordHeader';
import { NumberInput } from '../../components/NumberInput';

export const PR_STATUSES = [
  { value: 'DRAFT', label: 'Draft' },
  { value: 'PENDING_APPROVAL', label: 'Pending approval' },
  { value: 'APPROVED', label: 'Approved' },
  { value: 'REJECTED', label: 'Rejected' },
  { value: 'PARTIALLY_ORDERED', label: 'Partly ordered' },
  { value: 'ORDERED', label: 'Ordered' },
  { value: 'CANCELLED', label: 'Cancelled' },
];

/**
 * Re-exported so the dozen call sites across G-CHAIN keep working, but the
 * rules now live in one place for the whole application. This copy, and eight
 * others like it, had already drifted apart.
 */
export { statusTone };

/** `humanise` under the name G-CHAIN already calls it. */
export const label = humanise;

/**
 * The register lives under both menus (G-OPS for the people who raise
 * requests, G-CHAIN for the people who work them). Every link out of it stays
 * in the menu it was opened from, so the sidebar does not jump modules.
 */
function usePrBase(): string {
  const { pathname } = useLocation();
  return pathname.startsWith('/g-ops') ? '/g-ops/purchase-requests' : '/g-chain/purchase-requests';
}

/** Today + n days as `YYYY-MM-DD` in local time, for a date input. */
function daysFromToday(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() + n);
  const pad = (v: number) => String(v).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

interface PrRow {
  id: string;
  number: string;
  kind: string;
  status: string;
  purpose: string;
  neededBy: string | null;
  createdAt: string;
  job: { id: string; number: string; name: string } | null;
  warehouse: { id: string; name: string } | null;
  requestedBy: { id: string; name: string };
  itemCount: number;
  estimatedTotal: number;
  canvassCount: number;
  orderCount: number;
}

export function PurchaseRequests() {
  const { can } = useAuth();
  const navigate = useNavigate();
  const base = usePrBase();
  const [params, setParams] = useSearchParams();
  // `?new=1&jobId=` — the job workspace's "+ Purchase request" lands here with
  // the project already chosen.
  const [creating, setCreating] = useState(
    () => params.get('new') === '1' && can('gchain.purchase_requests.create'),
  );
  const [reload, setReload] = useState(0);
  const presetJobId = params.get('jobId');

  /** Drop the one-shot keys so a reload does not reopen the modal. */
  function clearPrefill() {
    if (!params.has('new') && !params.has('jobId')) return;
    const next = new URLSearchParams(params);
    next.delete('new');
    next.delete('jobId');
    setParams(next, { replace: true });
  }

  const columns: Column<PrRow>[] = [
    { key: 'number', label: 'Number', sortKey: 'number', width: '160px', render: (r) => <span className="mono">{r.number}</span> },
    {
      key: 'purpose',
      label: 'Request',
      render: (r) => (
        <div>
          <div>{r.purpose}</div>
          <div className="faint">
            {r.job ? `${r.job.number} — ${r.job.name}` : (r.warehouse?.name ?? 'Stock')}
          </div>
        </div>
      ),
    },
    {
      key: 'kind',
      label: 'Type',
      render: (r) => (
        <span className="badge" title={r.kind === 'DIRECT_TO_JOB' ? 'Charges the project when received' : 'Charges a project when issued from stock'}>
          {r.kind === 'DIRECT_TO_JOB' ? 'direct to job' : 'stock'}
        </span>
      ),
    },
    { key: 'items', label: 'Lines', align: 'right', render: (r) => r.itemCount },
    {
      key: 'estimatedTotal',
      label: 'Estimated',
      align: 'right',
      render: (r) => <span className="mono">{formatMoney(r.estimatedTotal)}</span>,
    },
    { key: 'requestedBy', label: 'Raised by', render: (r) => r.requestedBy.name },
    { key: 'neededBy', label: 'Needed by', sortKey: 'neededBy', render: (r) => formatDate(r.neededBy) },
    {
      key: 'progress',
      label: 'Sourcing',
      render: (r) =>
        r.orderCount > 0 ? (
          <span className="badge ok">{r.orderCount} order{r.orderCount === 1 ? '' : 's'}</span>
        ) : r.canvassCount > 0 ? (
          <span className="badge info">canvassing</span>
        ) : (
          <span className="faint">—</span>
        ),
      optional: true,
    },
    {
      key: 'status',
      label: 'Status',
      render: (r) => <StatusBadge status={r.status} />,
    },
  ];

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Purchase Requests</h1>
          <p>
            Two kinds, and the difference matters. <strong>Direct to job</strong> commits the
            project's budget now and charges it when the goods arrive.{' '}
            <strong>Stock replenishment</strong> buys for the warehouse and charges a project only
            when it is issued — so material is never counted against a job twice.
          </p>
        </div>
      </div>

      <DataList<PrRow>
        listKey="purchase-requests"
        endpoint="/purchase-requests"
        columns={columns}
        rowKey={(r) => r.id}
        scoped
        searchPlaceholder="Search number, purpose, project…"
        reloadToken={reload}
        onRowClick={(r) => navigate(`${base}/${r.id}`)}
        emptyTitle="No purchase requests yet"
        filters={[
          { key: 'status', label: 'Status', options: PR_STATUSES },
          {
            key: 'kind',
            label: 'Type',
            options: [
              { value: 'DIRECT_TO_JOB', label: 'Direct to job' },
              { value: 'STOCK_REPLENISHMENT', label: 'Stock replenishment' },
            ],
          },
        ]}
        actions={
          can('gchain.purchase_requests.create') ? (
            <button className="btn btn-primary btn-sm" onClick={() => setCreating(true)}>
              + New request
            </button>
          ) : null
        }
      />

      {creating && (
        <NewPrModal
          presetJobId={presetJobId}
          onClose={() => {
            setCreating(false);
            clearPrefill();
          }}
          onCreated={(id) => {
            setCreating(false);
            setReload((r) => r + 1);
            navigate(`${base}/${id}`);
          }}
        />
      )}
    </div>
  );
}

function NewPrModal({
  presetJobId,
  onClose,
  onCreated,
}: {
  /** From `?jobId=`: a direct-to-job request for this project, not re-pickable. */
  presetJobId: string | null;
  onClose: () => void;
  onCreated: (id: string) => void;
}) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [jobs, setJobs] = useState<{ id: string; number: string; name: string }[]>([]);
  const [presetJob, setPresetJob] = useState<{ number: string; name: string } | null>(null);
  const [warehouses, setWarehouses] = useState<{ id: string; name: string }[]>([]);
  const [form, setForm] = useState({
    kind: 'DIRECT_TO_JOB',
    jobId: presetJobId ?? '',
    warehouseId: '',
    purpose: '',
    // A week out: most requests are wanted soon, and a blank date is the one
    // nobody chases.
    neededBy: daysFromToday(7),
  });

  useEffect(() => {
    api
      .get<typeof jobs>('/jobs/lookup')
      .then((rows) => {
        setJobs(rows);
        const hit = presetJobId ? rows.find((j) => j.id === presetJobId) : undefined;
        if (hit) setPresetJob({ number: hit.number, name: hit.name });
      })
      .catch(() => {});
    api.get<{ id: string; name: string }[]>('/warehouses').then(setWarehouses).catch(() => {});
  }, [presetJobId]);

  async function create() {
    setBusy(true);
    setError(null);
    try {
      const created = await api.post<{ id: string }>('/purchase-requests', {
        kind: form.kind,
        jobId: form.jobId || null,
        warehouseId: form.warehouseId || null,
        purpose: form.purpose,
        neededBy: form.neededBy || null,
      });
      toast('ok', 'Request created — add the lines next');
      onCreated(created.id);
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  }

  const direct = form.kind === 'DIRECT_TO_JOB';

  return (
    <Modal
      title="New purchase request"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button
            className="btn btn-primary"
            onClick={create}
            disabled={busy || form.purpose.length < 3 || (direct ? !form.jobId : !form.warehouseId)}
          >
            {busy ? 'Creating…' : 'Create'}
          </button>
        </>
      }
    >
      <ErrorBox error={error} />

      {!presetJobId && (
        <Field label="What is this for?">
          <div className="scope-switch">
            <button
              type="button"
              className={direct ? 'active' : ''}
              aria-pressed={direct}
              onClick={() => setForm({ ...form, kind: 'DIRECT_TO_JOB', warehouseId: '' })}
            >
              A project
            </button>
            <button
              type="button"
              className={!direct ? 'active' : ''}
              aria-pressed={!direct}
              onClick={() => setForm({ ...form, kind: 'STOCK_REPLENISHMENT', jobId: '' })}
            >
              Warehouse stock
            </button>
          </div>
        </Field>
      )}

      <div className="alert info">
        {direct
          ? 'This commits the project’s budget when approved, and charges it when the goods arrive.'
          : 'This buys for the warehouse. No project is charged until the stock is issued to one.'}
      </div>

      {presetJobId ? (
        <Field label="Project">
          {/* Chosen by the page that sent you here — shown, not re-pickable. */}
          <div className="readback">
            {presetJob ? `${presetJob.number} — ${presetJob.name}` : 'The project you came from'}
          </div>
        </Field>
      ) : direct ? (
        <Field label="Project">
          <select value={form.jobId} onChange={(e) => setForm({ ...form, jobId: e.target.value })}>
            <option value="">— choose —</option>
            {jobs.map((j) => (
              <option key={j.id} value={j.id}>
                {j.number} — {j.name}
              </option>
            ))}
          </select>
        </Field>
      ) : (
        <Field label="Warehouse">
          <select
            value={form.warehouseId}
            onChange={(e) => setForm({ ...form, warehouseId: e.target.value })}
          >
            <option value="">— choose —</option>
            {warehouses.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name}
              </option>
            ))}
          </select>
        </Field>
      )}

      {direct && (
        <Field label="Deliver to warehouse" hint="Optional — if the goods pass through the store">
          <select
            value={form.warehouseId}
            onChange={(e) => setForm({ ...form, warehouseId: e.target.value })}
          >
            <option value="">— straight to site —</option>
            {warehouses.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name}
              </option>
            ))}
          </select>
        </Field>
      )}

      <Field label="Purpose">
        <input
          value={form.purpose}
          placeholder="Pipe and fittings for the oxygen skid"
          onChange={(e) => setForm({ ...form, purpose: e.target.value })}
        />
      </Field>
      <Field label="Needed by">
        <input
          type="date"
          value={form.neededBy}
          onChange={(e) => setForm({ ...form, neededBy: e.target.value })}
        />
      </Field>
    </Modal>
  );
}

// ════════════════════════════════════════════════════════════════════
//  DETAIL
// ════════════════════════════════════════════════════════════════════

interface PrItem {
  id: string;
  description: string;
  quantity: number;
  unit: string;
  estimatedCost: number;
  estimatedAmount: number;
  orderedQty: number;
  item: { id: string; code: string; name: string } | null;
  costCategory: { id: string; code: string; name: string } | null;
}

interface PrDetail {
  id: string;
  number: string;
  kind: string;
  status: string;
  purpose: string;
  neededBy: string | null;
  notes: string | null;
  createdAt: string;
  canEdit: boolean;
  estimatedTotal: number;
  job: { id: string; number: string; name: string } | null;
  warehouse: { id: string; name: string } | null;
  requestedBy: { id: string; name: string };
  items: PrItem[];
  canvasses: { id: string; number: string; status: string; createdAt: string }[];
  orders: { id: string; number: string; status: string; total: number; supplier: { id: string; name: string } }[];
  budget: Record<string, { budgeted: number; committed: number; incurred: number; available: number }>;
}

export function PurchaseRequestDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const base = usePrBase();
  const { can } = useAuth();
  const toast = useToast();

  const [pr, setPr] = useState<PrDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [adding, setAdding] = useState(false);
  // Bumped on every reload so the approval chain re-reads after a submit —
  // the chain lives behind its own endpoint and will not know otherwise.
  const [reload, setReload] = useState(0);

  const load = useCallback(async () => {
    if (!id) return;
    try {
      setPr(await api.get<PrDetail>(`/purchase-requests/${id}`));
      setReload((n) => n + 1);
      setError(null);
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading) return <Loading />;
  if (!pr) return <ErrorBox error={error ?? new Error('Request not found')} />;

  async function submit() {
    if (!pr) return;
    try {
      await api.post(`/purchase-requests/${pr.id}/submit`);
      toast('ok', 'Submitted for approval');
      await load();
    } catch (err) {
      setError(err);
    }
  }

  async function startCanvass() {
    if (!pr) return;
    try {
      const created = await api.post<{ id: string }>('/canvasses', { requestId: pr.id });
      navigate(`/g-chain/canvass/${created.id}`);
    } catch (err) {
      setError(err);
    }
  }

  async function raiseOrder() {
    if (!pr) return;
    navigate(`/g-chain/purchase-orders?fromRequest=${pr.id}`);
  }

  // Which budget lines this request would strain.
  const strained = pr.job
    ? pr.items
        .filter((i) => i.costCategory)
        .reduce((acc, i) => {
          const key = i.costCategory!.id;
          acc[key] = (acc[key] ?? 0) + i.estimatedAmount;
          return acc;
        }, {} as Record<string, number>)
    : {};

  return (
    <div>
      <div className="breadcrumb">
        {pr.job && (
          <>
            <Link to={`/g-ops/projects/${pr.job.id}`}>{pr.job.number}</Link>
            <span className="sep">›</span>
          </>
        )}
        <Link to={base}>Purchase Requests</Link>
        <span className="sep">›</span>
        <span className="mono">{pr.number}</span>
      </div>

      <RecordHeader
        type="Purchase Request"
        code={pr.number}
        title={pr.purpose}
        status={pr.status}
        amount={formatMoney(pr.estimatedTotal)}
        // Estimated, not contracted: a PR is a request, and what it finally
        // costs is settled at the purchase order.
        amountLabel="Estimated total"
        actions={
          <>
            <button
              className="btn"
              onClick={() =>
                openPdf(`/api/purchase-requests/${pr.id}/pdf`, () => toast('error', 'Could not print'))
              }
            >
              Print
            </button>
            {pr.canEdit && pr.items.length > 0 && (
              <button className="btn btn-ok" onClick={submit}>
                Submit for approval
              </button>
            )}
            {(pr.status === 'APPROVED' || pr.status === 'PARTIALLY_ORDERED') &&
              can('gchain.canvass.create') && (
                <button className="btn" onClick={startCanvass}>
                  Start canvass
                </button>
              )}
            {(pr.status === 'APPROVED' || pr.status === 'PARTIALLY_ORDERED') &&
              can('gchain.purchase_orders.create') && (
                <button className="btn btn-primary" onClick={raiseOrder}>
                  Raise order
                </button>
              )}
          </>
        }
      />

      {/* The kind and the counterparty, under the header rather than in it —
          the header answers what/which/what state, this answers the rest. */}
      <p className="record-head-meta proc-meta">
        {pr.kind === 'DIRECT_TO_JOB' ? 'Direct to project' : 'Stock replenishment'}
        {pr.job ? ` · ${pr.job.name}` : pr.warehouse ? ` · ${pr.warehouse.name}` : ''} ·{' '}
        requested by {pr.requestedBy.name}
      </p>

      <DocumentApproval documentType="purchase_request" documentId={pr.id} reloadToken={reload} />

      <ErrorBox error={error} />

      {pr.status === 'PENDING_APPROVAL' && (
        <div className="alert info">
          With the approver. It cannot be changed until they decide.
        </div>
      )}
      {pr.status === 'APPROVED' && pr.kind === 'DIRECT_TO_JOB' && (
        <div className="alert ok">
          Approved — {formatMoney(pr.estimatedTotal)} is now committed against the project's budget
          at estimated prices. Raising the order replaces that with the price actually agreed.
        </div>
      )}

      <div className="card proc-card">
        <div className="proc-card-head">
          <h3 className="card-title">Items requested</h3>
          {pr.canEdit && (
            <button className="btn btn-primary btn-sm" onClick={() => setAdding(true)}>
              + Add line
            </button>
          )}
        </div>

        {pr.items.length === 0 ? (
          <Empty
            title="No lines yet"
            hint="Add what is needed, with quantities and estimated cost."
            action={
              pr.canEdit ? (
                <button className="btn btn-primary btn-sm" onClick={() => setAdding(true)}>
                  + Add line
                </button>
              ) : undefined
            }
          />
        ) : (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Description</th>
                  <th>Budget line</th>
                  <th className="right">Qty</th>
                  <th>Unit</th>
                  <th className="right">Est. cost</th>
                  <th className="right">Est. amount</th>
                  <th className="right">Ordered</th>
                  {pr.canEdit && <th className="proc-col-actions" aria-label="Actions" />}
                </tr>
              </thead>
              <tbody>
                {pr.items.map((i) => (
                  <tr key={i.id}>
                    <td>
                      <div>{i.description}</div>
                      {i.item && <div className="faint mono">{i.item.code}</div>}
                    </td>
                    <td>{i.costCategory?.name ?? <span className="faint">—</span>}</td>
                    <td className="right mono">{i.quantity}</td>
                    <td>{i.unit}</td>
                    <td className="right mono">{formatMoney(i.estimatedCost)}</td>
                    <td className="right mono">{formatMoney(i.estimatedAmount)}</td>
                    <td className="right mono faint">{i.orderedQty || '—'}</td>
                    {pr.canEdit && (
                      <td>
                        <div className="proc-row-actions">
                          <button
                            className="btn btn-ghost btn-sm"
                            aria-label={`Remove ${i.description}`}
                            onClick={async () => {
                              try {
                                await api.del(`/purchase-requests/${pr.id}/items/${i.id}`);
                                await load();
                              } catch (err) {
                                setError(err);
                              }
                            }}
                          >
                            Remove
                          </button>
                        </div>
                      </td>
                    )}
                  </tr>
                ))}
                <tr>
                  <td colSpan={5} className="right">
                    <strong>ESTIMATED TOTAL</strong>
                  </td>
                  <td className="right mono">
                    <strong>{formatMoney(pr.estimatedTotal)}</strong>
                  </td>
                  <td colSpan={pr.canEdit ? 2 : 1} />
                </tr>
              </tbody>
            </table>
          </div>
        )}
      </div>

      {pr.job && Object.keys(pr.budget).length > 0 && (
        <div className="card proc-card">
          <h3 className="card-title">Against the project budget</h3>
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Budget line</th>
                  <th className="right">Budgeted</th>
                  <th className="right">Already committed</th>
                  <th className="right">Available</th>
                  <th className="right">This request</th>
                  <th className="right">After</th>
                </tr>
              </thead>
              <tbody>
                {Object.entries(pr.budget).map(([categoryId, b]) => {
                  const asked = strained[categoryId] ?? 0;
                  const after = b.available - asked;
                  const category = pr.items.find((i) => i.costCategory?.id === categoryId)?.costCategory;
                  return (
                    <tr key={categoryId}>
                      <td>{category?.name ?? categoryId}</td>
                      <td className="right mono">{formatMoney(b.budgeted)}</td>
                      <td className="right mono">{formatMoney(b.committed)}</td>
                      <td className="right mono">{formatMoney(b.available)}</td>
                      <td className="right mono">{formatMoney(asked)}</td>
                      <td className={`right mono${after < 0 ? ' proc-over' : ''}`}>
                        {formatMoney(after)}
                        {after < 0 && <span className="visually-hidden"> — over budget</span>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {Object.entries(pr.budget).some(([id, b]) => (strained[id] ?? 0) > b.available) && (
            <div className="alert error proc-card-note">
              This request exceeds what is left on at least one budget line. Submitting it will be
              blocked — raise a budget request first, or reduce the quantities.
            </div>
          )}
        </div>
      )}

      {(pr.canvasses.length > 0 || pr.orders.length > 0) && (
        <div className="grid grid-2">
          {pr.canvasses.length > 0 && (
            <div className="card">
              <h3 className="card-title">Canvasses</h3>
              <div className="stack">
                {pr.canvasses.map((c) => (
                  <Link key={c.id} to={`/g-chain/canvass/${c.id}`} className="row">
                    <span className="mono">{c.number}</span>
                    <StatusBadge status={c.status} extra={{ AWARDED: 'ok' }} />
                    <span className="faint">{formatDate(c.createdAt)}</span>
                  </Link>
                ))}
              </div>
            </div>
          )}
          {pr.orders.length > 0 && (
            <div className="card">
              <h3 className="card-title">Purchase orders</h3>
              <div className="stack">
                {pr.orders.map((o) => (
                  <Link key={o.id} to={`/g-chain/purchase-orders/${o.id}`} className="row">
                    <span className="mono">{o.number}</span>
                    <StatusBadge status={o.status} />
                    <span>{o.supplier.name}</span>
                    <span className="mono faint">{formatMoney(o.total)}</span>
                  </Link>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {adding && (
        <AddLineModal
          pr={pr}
          onClose={() => setAdding(false)}
          onSaved={() => {
            setAdding(false);
            void load();
          }}
        />
      )}
    </div>
  );
}

function AddLineModal({ pr, onClose, onSaved }: { pr: PrDetail; onClose: () => void; onSaved: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [items, setItems] = useState<
    { id: string; code: string; name: string; unit: string; standardCost: string | null }[]
  >([]);
  const [categories, setCategories] = useState<{ id: string; name: string }[]>([]);
  const [form, setForm] = useState({
    itemId: '',
    costCategoryId: '',
    description: '',
    quantity: '1',
    unit: 'pcs',
    estimatedCost: '',
  });

  useEffect(() => {
    api.get<typeof items>('/items/lookup').then(setItems).catch(() => {});
    api.get<typeof categories>('/reference/cost-categories').then(setCategories).catch(() => {});
  }, []);

  function pickItem(itemId: string) {
    const item = items.find((i) => i.id === itemId);
    setForm((f) => ({
      ...f,
      itemId,
      description: item && !f.description ? item.name : f.description,
      unit: item?.unit ?? f.unit,
      estimatedCost: item?.standardCost != null && !f.estimatedCost ? String(item.standardCost) : f.estimatedCost,
    }));
  }

  async function save() {
    setBusy(true);
    setError(null);
    try {
      await api.post(`/purchase-requests/${pr.id}/items`, {
        itemId: form.itemId || null,
        costCategoryId: form.costCategoryId || null,
        description: form.description,
        quantity: Number(form.quantity),
        unit: form.unit,
        estimatedCost: Number(form.estimatedCost || 0),
      });
      onSaved();
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  }

  const amount = (Number(form.quantity) || 0) * (Number(form.estimatedCost) || 0);
  // The server refuses a direct-to-job line with no budget line; say so here
  // rather than let the button through to a refusal.
  const needsCategory = pr.kind === 'DIRECT_TO_JOB' && !form.costCategoryId;

  return (
    <Modal
      title="Add a line"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button
            className="btn btn-primary"
            onClick={save}
            disabled={busy || !form.description || needsCategory || !(Number(form.quantity) > 0)}
            title={needsCategory ? 'Choose the budget line first' : undefined}
          >
            {busy ? 'Adding…' : 'Add'}
          </button>
        </>
      }
    >
      <ErrorBox error={error} />
      <Field label="Item" hint="Optional — picking one fills the rest in">
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
        <input value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
      </Field>
      {pr.kind === 'DIRECT_TO_JOB' && (
        <Field label="Budget line" hint="Required — which part of the project budget this comes out of">
          <select
            value={form.costCategoryId}
            onChange={(e) => setForm({ ...form, costCategoryId: e.target.value })}
          >
            <option value="">— choose —</option>
            {categories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </Field>
      )}
      <div className="grid grid-3">
        <Field label="Quantity">
          <NumberInput
            kind="quantity"
            step="0.001"
            value={form.quantity}
            onChange={(e) => setForm({ ...form, quantity: e.target.value })}
          />
        </Field>
        <Field label="Unit">
          <input value={form.unit} onChange={(e) => setForm({ ...form, unit: e.target.value })} />
        </Field>
        <Field label="Estimated cost">
          <NumberInput
            kind="money"
            step="0.01"
            value={form.estimatedCost}
            onChange={(e) => setForm({ ...form, estimatedCost: e.target.value })}
          />
        </Field>
      </div>
      <div className="alert info proc-card-note">
        Estimated amount: <strong>{formatMoney(amount)}</strong>
      </div>
    </Modal>
  );
}
