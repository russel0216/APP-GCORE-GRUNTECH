import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { DataList, type Column } from '../../components/DataList';
import {
  Empty,
  ErrorBox,
  Field,
  Loading,
  Modal,
  formatDate,
  formatMoney,
  useToast,
} from '../../components/ui';
import { ProgressBar } from '../delivery/Projects';
import { label, openPdf, statusTone } from './PurchaseRequests';

// ════════════════════════════════════════════════════════════════════
//  CANVASS
// ════════════════════════════════════════════════════════════════════

interface CanvassRow {
  id: string;
  number: string;
  status: string;
  createdAt: string;
  supplierCount: number;
  awarded: string | null;
  request: { id: string; number: string; purpose: string; job: { id: string; name: string } | null };
  createdBy: { id: string; name: string };
}

export function Canvasses() {
  const navigate = useNavigate();

  const columns: Column<CanvassRow>[] = [
    { key: 'number', label: 'Number', sortKey: 'number', width: '160px', render: (c) => <span className="mono">{c.number}</span> },
    {
      key: 'request',
      label: 'For',
      render: (c) => (
        <div>
          <div>{c.request.purpose}</div>
          <div className="faint mono">{c.request.number}</div>
        </div>
      ),
    },
    {
      key: 'suppliers',
      label: 'Suppliers',
      align: 'right',
      render: (c) => (
        <span className={c.supplierCount < 3 ? 'faint' : ''} title={c.supplierCount < 3 ? 'Three quotes is the convention' : undefined}>
          {c.supplierCount}
        </span>
      ),
    },
    { key: 'awarded', label: 'Awarded to', render: (c) => c.awarded ?? <span className="faint">—</span> },
    { key: 'createdBy', label: 'Opened by', render: (c) => c.createdBy.name },
    { key: 'createdAt', label: 'Opened', sortKey: 'createdAt', render: (c) => formatDate(c.createdAt) },
    {
      key: 'status',
      label: 'Status',
      render: (c) => <span className={`badge ${c.status === 'AWARDED' ? 'ok' : 'warn'}`}>{label(c.status)}</span>,
    },
  ];

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Canvass / RFQ</h1>
          <p>
            Quote the same lines from several suppliers and compare like for like. The lowest
            complete quote is flagged, but the award is yours — price is not the only thing that
            matters.
          </p>
        </div>
      </div>

      <DataList<CanvassRow>
        listKey="canvasses"
        endpoint="/canvasses"
        columns={columns}
        rowKey={(c) => c.id}
        searchPlaceholder="Search number, request…"
        onRowClick={(c) => navigate(`/g-chain/canvass/${c.id}`)}
        emptyTitle="No canvasses yet"
        emptyHint="Start one from an approved purchase request."
        filters={[
          {
            key: 'status',
            label: 'Status',
            options: [
              { value: 'OPEN', label: 'Open' },
              { value: 'AWARDED', label: 'Awarded' },
            ],
          },
        ]}
      />
    </div>
  );
}

interface CanvassDetailData {
  id: string;
  number: string;
  status: string;
  notes: string | null;
  lowestSupplierId: string | null;
  request: {
    id: string;
    number: string;
    purpose: string;
    job: { id: string; number: string; name: string } | null;
    items: { id: string; description: string; quantity: number; unit: string; estimatedCost: number }[];
  };
  suppliers: {
    id: string;
    isSelected: boolean;
    leadTimeDays: number | null;
    terms: string | null;
    total: number;
    quotedCount: number;
    complete: boolean;
    supplier: { id: string; code: string; name: string; paymentTerms: string | null };
    quotes: { id: string; requestItemId: string; unitPrice: number }[];
  }[];
}

export function CanvassDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { can } = useAuth();
  const toast = useToast();

  const [canvass, setCanvass] = useState<CanvassDetailData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [adding, setAdding] = useState(false);
  const [quoting, setQuoting] = useState<CanvassDetailData['suppliers'][number] | null>(null);

  const load = useCallback(async () => {
    if (!id) return;
    try {
      setCanvass(await api.get<CanvassDetailData>(`/canvasses/${id}`));
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
  if (!canvass) return <ErrorBox error={error ?? new Error('Canvass not found')} />;

  async function award(supplierRowId: string) {
    if (!canvass) return;
    try {
      const res = await api.post<{ supplier: string }>(`/canvasses/${canvass.id}/award/${supplierRowId}`);
      toast('ok', `Awarded to ${res.supplier}`);
      await load();
    } catch (err) {
      setError(err);
    }
  }

  const winner = canvass.suppliers.find((s) => s.isSelected);

  return (
    <div>
      <div className="breadcrumb">
        <Link to={`/g-chain/purchase-requests/${canvass.request.id}`}>{canvass.request.number}</Link>
        <span className="sep">›</span>
        <Link to="/g-chain/canvass">Canvass</Link>
        <span className="sep">›</span>
        <span className="mono">{canvass.number}</span>
      </div>

      <div className="page-head">
        <div>
          <h1>{canvass.request.purpose}</h1>
          <p>
            {canvass.request.job ? `${canvass.request.job.number} · ` : ''}
            {canvass.suppliers.length} supplier{canvass.suppliers.length === 1 ? '' : 's'} quoting
            <span className={`badge ${canvass.status === 'AWARDED' ? 'ok' : 'warn'}`} style={{ marginLeft: 8 }}>
              {label(canvass.status)}
            </span>
          </p>
        </div>
        <div className="row">
          {canvass.status === 'OPEN' && can('gchain.canvass.edit_all') && (
            <button className="btn btn-primary" onClick={() => setAdding(true)}>
              + Add supplier
            </button>
          )}
          {winner && can('gchain.purchase_orders.create') && (
            <button
              className="btn btn-primary"
              onClick={() => navigate(`/g-chain/purchase-orders?fromCanvass=${canvass.id}`)}
            >
              Raise order
            </button>
          )}
        </div>
      </div>

      <ErrorBox error={error} />

      {canvass.suppliers.length > 0 && canvass.suppliers.length < 3 && canvass.status === 'OPEN' && (
        <div className="alert info">
          Only {canvass.suppliers.length} supplier{canvass.suppliers.length === 1 ? '' : 's'} so far.
          Three quotes is the usual standard for a defensible award.
        </div>
      )}

      <div className="card">
        <h3 className="card-title">Quote comparison</h3>
        {canvass.suppliers.length === 0 ? (
          <Empty title="No suppliers yet" hint="Add the suppliers you are asking to quote." />
        ) : (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Item</th>
                  <th className="right">Qty</th>
                  <th className="right">Estimate</th>
                  {canvass.suppliers.map((s) => (
                    <th key={s.id} className="right">
                      {s.supplier.name}
                      {s.isSelected && (
                        <span className="badge ok" style={{ marginLeft: 6 }}>
                          awarded
                        </span>
                      )}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {canvass.request.items.map((item) => {
                  const prices = canvass.suppliers.map(
                    (s) => s.quotes.find((qq) => qq.requestItemId === item.id)?.unitPrice,
                  );
                  const valid = prices.filter((p): p is number => p !== undefined && p > 0);
                  const best = valid.length ? Math.min(...valid) : null;
                  return (
                    <tr key={item.id}>
                      <td>{item.description}</td>
                      <td className="right mono">
                        {item.quantity} {item.unit}
                      </td>
                      <td className="right mono faint">{formatMoney(item.estimatedCost)}</td>
                      {canvass.suppliers.map((s, i) => {
                        const price = prices[i];
                        return (
                          <td
                            key={s.id}
                            className="right mono"
                            style={{
                              color: price !== undefined && price === best ? 'var(--neon)' : undefined,
                            }}
                          >
                            {price === undefined ? <span className="faint">—</span> : formatMoney(price)}
                          </td>
                        );
                      })}
                    </tr>
                  );
                })}
                <tr>
                  <td colSpan={3} className="right">
                    <strong>TOTAL</strong>
                  </td>
                  {canvass.suppliers.map((s) => (
                    <td
                      key={s.id}
                      className="right mono"
                      style={{ color: s.id === canvass.lowestSupplierId ? 'var(--neon)' : undefined }}
                    >
                      <strong>{s.complete ? formatMoney(s.total) : <span className="faint">incomplete</span>}</strong>
                    </td>
                  ))}
                </tr>
                <tr>
                  <td colSpan={3} className="right faint">
                    Lead time
                  </td>
                  {canvass.suppliers.map((s) => (
                    <td key={s.id} className="right faint">
                      {s.leadTimeDays != null ? `${s.leadTimeDays} d` : '—'}
                    </td>
                  ))}
                </tr>
                <tr>
                  <td colSpan={3} className="right faint">
                    Terms
                  </td>
                  {canvass.suppliers.map((s) => (
                    <td key={s.id} className="right faint">
                      {s.terms ?? s.supplier.paymentTerms ?? '—'}
                    </td>
                  ))}
                </tr>
                {canvass.status === 'OPEN' && can('gchain.canvass.edit_all') && (
                  <tr>
                    <td colSpan={3} />
                    {canvass.suppliers.map((s) => (
                      <td key={s.id} className="right">
                        <div className="row" style={{ justifyContent: 'flex-end', gap: 5 }}>
                          <button className="btn btn-sm" onClick={() => setQuoting(s)}>
                            Quote
                          </button>
                          <button
                            className="btn btn-sm btn-ok"
                            disabled={!s.quotes.length}
                            onClick={() => award(s.id)}
                          >
                            Award
                          </button>
                        </div>
                      </td>
                    ))}
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )}

        {canvass.lowestSupplierId && canvass.status === 'OPEN' && (
          <div className="alert info" style={{ marginTop: 12, marginBottom: 0 }}>
            Lowest complete quote:{' '}
            <strong>
              {canvass.suppliers.find((s) => s.id === canvass.lowestSupplierId)?.supplier.name}
            </strong>{' '}
            at {formatMoney(canvass.suppliers.find((s) => s.id === canvass.lowestSupplierId)?.total ?? 0)}.
            Lead time and terms are shown above — award on the whole picture, not just the number.
          </div>
        )}
      </div>

      {adding && (
        <AddSupplierModal
          canvassId={canvass.id}
          existing={canvass.suppliers.map((s) => s.supplier.id)}
          onClose={() => setAdding(false)}
          onSaved={() => {
            setAdding(false);
            void load();
          }}
        />
      )}

      {quoting && (
        <QuoteModal
          canvassId={canvass.id}
          supplierRow={quoting}
          items={canvass.request.items}
          onClose={() => setQuoting(null)}
          onSaved={() => {
            setQuoting(null);
            void load();
          }}
        />
      )}
    </div>
  );
}

function AddSupplierModal({
  canvassId,
  existing,
  onClose,
  onSaved,
}: {
  canvassId: string;
  existing: string[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [suppliers, setSuppliers] = useState<{ id: string; name: string }[]>([]);
  const [form, setForm] = useState({ supplierId: '', leadTimeDays: '', terms: '' });

  useEffect(() => {
    api.get<typeof suppliers>('/suppliers/lookup').then(setSuppliers).catch(() => {});
  }, []);

  async function save() {
    setBusy(true);
    setError(null);
    try {
      await api.post(`/canvasses/${canvassId}/suppliers`, {
        supplierId: form.supplierId,
        leadTimeDays: form.leadTimeDays === '' ? null : Number(form.leadTimeDays),
        terms: form.terms || null,
      });
      onSaved();
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  }

  const available = suppliers.filter((s) => !existing.includes(s.id));

  return (
    <Modal
      title="Add a supplier to canvass"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button className="btn btn-primary" onClick={save} disabled={busy || !form.supplierId}>
            {busy ? 'Adding…' : 'Add'}
          </button>
        </>
      }
    >
      <ErrorBox error={error} />
      <Field label="Supplier">
        <select value={form.supplierId} onChange={(e) => setForm({ ...form, supplierId: e.target.value })}>
          <option value="">— choose —</option>
          {available.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
      </Field>
      <div className="grid grid-2">
        <Field label="Lead time (days)">
          <input
            type="number"
            value={form.leadTimeDays}
            onChange={(e) => setForm({ ...form, leadTimeDays: e.target.value })}
          />
        </Field>
        <Field label="Terms">
          <input value={form.terms} onChange={(e) => setForm({ ...form, terms: e.target.value })} />
        </Field>
      </div>
    </Modal>
  );
}

function QuoteModal({
  canvassId,
  supplierRow,
  items,
  onClose,
  onSaved,
}: {
  canvassId: string;
  supplierRow: CanvassDetailData['suppliers'][number];
  items: CanvassDetailData['request']['items'];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [prices, setPrices] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      items.map((i) => [
        i.id,
        String(supplierRow.quotes.find((qq) => qq.requestItemId === i.id)?.unitPrice ?? ''),
      ]),
    ),
  );

  async function save() {
    setBusy(true);
    setError(null);
    try {
      await api.put(`/canvasses/${canvassId}/suppliers/${supplierRow.id}/quotes`, {
        quotes: Object.entries(prices)
          .filter(([, v]) => v !== '')
          .map(([requestItemId, v]) => ({ requestItemId, unitPrice: Number(v) })),
      });
      onSaved();
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  }

  const total = items.reduce((s, i) => s + i.quantity * (Number(prices[i.id]) || 0), 0);

  return (
    <Modal
      wide
      title={`Quote from ${supplierRow.supplier.name}`}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button className="btn btn-primary" onClick={save} disabled={busy}>
            {busy ? 'Saving…' : 'Save quote'}
          </button>
        </>
      }
    >
      <ErrorBox error={error} />
      <p className="muted" style={{ marginTop: 0 }}>
        Leave a line blank if they did not quote it. An incomplete quote is excluded from the
        lowest-total comparison, because it is not a like-for-like offer.
      </p>
      <div className="table-wrap">
        <table className="data">
          <thead>
            <tr>
              <th>Item</th>
              <th className="right">Qty</th>
              <th className="right" style={{ width: 140 }}>
                Unit price
              </th>
              <th className="right">Amount</th>
            </tr>
          </thead>
          <tbody>
            {items.map((i) => (
              <tr key={i.id}>
                <td>{i.description}</td>
                <td className="right mono">
                  {i.quantity} {i.unit}
                </td>
                <td>
                  <input
                    className="mono"
                    type="number"
                    step="0.01"
                    style={{ textAlign: 'right', padding: '5px 7px' }}
                    value={prices[i.id] ?? ''}
                    onChange={(e) => setPrices({ ...prices, [i.id]: e.target.value })}
                  />
                </td>
                <td className="right mono">
                  {prices[i.id] ? formatMoney(i.quantity * Number(prices[i.id])) : '—'}
                </td>
              </tr>
            ))}
            <tr>
              <td colSpan={3} className="right">
                <strong>TOTAL</strong>
              </td>
              <td className="right mono">
                <strong>{formatMoney(total)}</strong>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </Modal>
  );
}

// ════════════════════════════════════════════════════════════════════
//  PURCHASE ORDERS
// ════════════════════════════════════════════════════════════════════

interface PoRow {
  id: string;
  number: string;
  kind: string;
  status: string;
  orderDate: string;
  deliveryDate: string | null;
  total: number;
  receivedPct: number;
  supplier: { id: string; name: string };
  job: { id: string; number: string; name: string } | null;
  request: { id: string; number: string } | null;
}

export function PurchaseOrders() {
  const navigate = useNavigate();
  const { can } = useAuth();
  const [params, setParams] = useSearchParams();
  const [creating, setCreating] = useState(
    () => params.has('fromRequest') || params.has('fromCanvass'),
  );
  const [reload, setReload] = useState(0);

  const columns: Column<PoRow>[] = [
    { key: 'number', label: 'Number', sortKey: 'number', width: '160px', render: (o) => <span className="mono">{o.number}</span> },
    {
      key: 'supplier',
      label: 'Supplier',
      render: (o) => (
        <div>
          <div>{o.supplier.name}</div>
          <div className="faint">{o.job ? `${o.job.number} — ${o.job.name}` : 'Stock'}</div>
        </div>
      ),
    },
    { key: 'orderDate', label: 'Ordered', sortKey: 'orderDate', render: (o) => formatDate(o.orderDate) },
    { key: 'deliveryDate', label: 'Required', render: (o) => formatDate(o.deliveryDate) },
    {
      key: 'total',
      label: 'Total',
      sortKey: 'total',
      align: 'right',
      render: (o) => <span className="mono">{formatMoney(o.total)}</span>,
    },
    {
      key: 'received',
      label: 'Received',
      width: '120px',
      render: (o) => <ProgressBar pct={o.receivedPct} />,
    },
    { key: 'request', label: 'From', render: (o) => o.request ? <span className="mono faint">{o.request.number}</span> : <span className="faint">—</span>, optional: true },
    {
      key: 'status',
      label: 'Status',
      render: (o) => <span className={`badge ${statusTone(o.status)}`}>{label(o.status)}</span>,
    },
  ];

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Purchase Orders</h1>
          <p>
            An issued order is a firm commitment against the project's budget, at the price
            actually agreed — it replaces the request's estimate rather than adding to it.
          </p>
        </div>
      </div>

      <DataList<PoRow>
        listKey="purchase-orders"
        endpoint="/purchase-orders"
        columns={columns}
        rowKey={(o) => o.id}
        searchPlaceholder="Search number, supplier, project…"
        reloadToken={reload}
        onRowClick={(o) => navigate(`/g-chain/purchase-orders/${o.id}`)}
        emptyTitle="No purchase orders yet"
        filters={[
          {
            key: 'status',
            label: 'Status',
            options: [
              { value: 'DRAFT', label: 'Draft' },
              { value: 'PENDING_APPROVAL', label: 'Pending' },
              { value: 'ISSUED', label: 'Issued' },
              { value: 'PARTIALLY_RECEIVED', label: 'Partly received' },
              { value: 'RECEIVED', label: 'Received' },
            ],
          },
        ]}
        actions={
          can('gchain.purchase_orders.create') ? (
            <button className="btn btn-primary btn-sm" onClick={() => setCreating(true)}>
              + New order
            </button>
          ) : null
        }
      />

      {creating && (
        <NewPoModal
          fromRequest={params.get('fromRequest')}
          fromCanvass={params.get('fromCanvass')}
          onClose={() => {
            setCreating(false);
            setParams({});
          }}
          onCreated={(id) => {
            setCreating(false);
            setParams({});
            setReload((r) => r + 1);
            navigate(`/g-chain/purchase-orders/${id}`);
          }}
        />
      )}
    </div>
  );
}

function NewPoModal({
  fromRequest,
  fromCanvass,
  onClose,
  onCreated,
}: {
  fromRequest: string | null;
  fromCanvass: string | null;
  onClose: () => void;
  onCreated: (id: string) => void;
}) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [suppliers, setSuppliers] = useState<{ id: string; name: string }[]>([]);
  const [context, setContext] = useState<string | null>(null);
  const [form, setForm] = useState({ supplierId: '', deliveryDate: '', terms: '', vatInclusive: false });

  useEffect(() => {
    api.get<typeof suppliers>('/suppliers/lookup').then(setSuppliers).catch(() => {});
  }, []);

  // From an awarded canvass the supplier is decided — preselect and explain.
  useEffect(() => {
    if (!fromCanvass) return;
    api
      .get<CanvassDetailData>(`/canvasses/${fromCanvass}`)
      .then((c) => {
        const winner = c.suppliers.find((s) => s.isSelected);
        if (winner) {
          setForm((f) => ({ ...f, supplierId: winner.supplier.id }));
          setContext(`From ${c.number}, awarded to ${winner.supplier.name} at ${formatMoney(winner.total)}.`);
        }
      })
      .catch(() => {});
  }, [fromCanvass]);

  useEffect(() => {
    if (!fromRequest || fromCanvass) return;
    api
      .get<{ number: string; purpose: string }>(`/purchase-requests/${fromRequest}`)
      .then((pr) => setContext(`From ${pr.number} — ${pr.purpose}. Lines carry over at estimated prices.`))
      .catch(() => {});
  }, [fromRequest, fromCanvass]);

  async function create() {
    setBusy(true);
    setError(null);
    try {
      const created = await api.post<{ id: string }>('/purchase-orders', {
        supplierId: form.supplierId,
        requestId: fromRequest || null,
        canvassId: fromCanvass || null,
        deliveryDate: form.deliveryDate || null,
        terms: form.terms || null,
        vatInclusive: form.vatInclusive,
      });
      toast('ok', 'Order created');
      onCreated(created.id);
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  }

  return (
    <Modal
      title="New purchase order"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button className="btn btn-primary" onClick={create} disabled={busy || !form.supplierId}>
            {busy ? 'Creating…' : 'Create'}
          </button>
        </>
      }
    >
      <ErrorBox error={error} />
      {context && <div className="alert info">{context}</div>}

      <Field label="Supplier">
        <select
          value={form.supplierId}
          disabled={!!fromCanvass}
          onChange={(e) => setForm({ ...form, supplierId: e.target.value })}
        >
          <option value="">— choose —</option>
          {suppliers.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
      </Field>
      <div className="grid grid-2">
        <Field label="Required by">
          <input
            type="date"
            value={form.deliveryDate}
            onChange={(e) => setForm({ ...form, deliveryDate: e.target.value })}
          />
        </Field>
        <Field label="Terms">
          <input value={form.terms} onChange={(e) => setForm({ ...form, terms: e.target.value })} />
        </Field>
      </div>
      <label className="checkbox">
        <input
          type="checkbox"
          checked={form.vatInclusive}
          onChange={(e) => setForm({ ...form, vatInclusive: e.target.checked })}
        />
        <span>Supplier prices include VAT</span>
      </label>
    </Modal>
  );
}

interface PoDetailData {
  id: string;
  number: string;
  kind: string;
  status: string;
  orderDate: string;
  deliveryDate: string | null;
  deliverTo: string | null;
  terms: string | null;
  notes: string | null;
  vatRate: number;
  vatInclusive: boolean;
  subtotal: number;
  vatAmount: number;
  total: number;
  supplier: { id: string; name: string; paymentTerms: string | null };
  job: { id: string; number: string; name: string } | null;
  warehouse: { id: string; name: string } | null;
  request: { id: string; number: string; purpose: string } | null;
  createdBy: { id: string; name: string };
  items: {
    id: string;
    description: string;
    quantity: number;
    unit: string;
    unitPrice: number;
    amount: number;
    receivedQty: number;
    outstandingQty: number;
    item: { id: string; code: string; name: string } | null;
    costCategory: { id: string; name: string } | null;
  }[];
  receivings: { id: string; number: string; receivedDate: string; receivedBy: { name: string } }[];
}

export function PurchaseOrderDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { can } = useAuth();
  const toast = useToast();

  const [po, setPo] = useState<PoDetailData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [receiving, setReceiving] = useState(false);

  const load = useCallback(async () => {
    if (!id) return;
    try {
      setPo(await api.get<PoDetailData>(`/purchase-orders/${id}`));
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
  if (!po) return <ErrorBox error={error ?? new Error('Order not found')} />;

  async function submit() {
    if (!po) return;
    try {
      await api.post(`/purchase-orders/${po.id}/submit`);
      toast('ok', 'Submitted for approval');
      await load();
    } catch (err) {
      setError(err);
    }
  }

  const outstanding = po.items.reduce((s, i) => s + i.outstandingQty, 0);

  return (
    <div>
      <div className="breadcrumb">
        {po.job && (
          <>
            <Link to={`/g-ops/projects/${po.job.id}`}>{po.job.number}</Link>
            <span className="sep">›</span>
          </>
        )}
        {po.request && (
          <>
            <Link to={`/g-chain/purchase-requests/${po.request.id}`}>{po.request.number}</Link>
            <span className="sep">›</span>
          </>
        )}
        <Link to="/g-chain/purchase-orders">Purchase Orders</Link>
        <span className="sep">›</span>
        <span className="mono">{po.number}</span>
      </div>

      <div className="page-head">
        <div>
          <h1>{po.supplier.name}</h1>
          <p>
            {po.job ? `${po.job.number} — ${po.job.name}` : 'Stock replenishment'} ·{' '}
            {formatDate(po.orderDate)}
            <span className={`badge ${statusTone(po.status)}`} style={{ marginLeft: 8 }}>
              {label(po.status)}
            </span>
          </p>
        </div>
        <div className="row">
          <button
            className="btn"
            onClick={() => openPdf(`/api/purchase-orders/${po.id}/pdf`, () => toast('error', 'Could not print'))}
          >
            Print
          </button>
          {po.status === 'DRAFT' && can('gchain.purchase_orders.create') && po.items.length > 0 && (
            <button className="btn btn-ok" onClick={submit}>
              Submit for approval
            </button>
          )}
          {(po.status === 'ISSUED' || po.status === 'PARTIALLY_RECEIVED') &&
            can('gchain.receiving.create') && (
              <button className="btn btn-primary" onClick={() => setReceiving(true)}>
                Receive goods
              </button>
            )}
        </div>
      </div>

      <ErrorBox error={error} />

      {po.status === 'ISSUED' && po.kind === 'DIRECT_TO_JOB' && (
        <div className="alert ok">
          Issued — {formatMoney(po.subtotal)} is committed against the project at the agreed price.
          The request's estimate has been released, so it is not counted twice.
        </div>
      )}

      <div className="grid grid-4" style={{ marginBottom: 18 }}>
        <Stat label="Subtotal" value={formatMoney(po.subtotal)} />
        <Stat label={`VAT ${(po.vatRate * 100).toFixed(0)}%`} value={formatMoney(po.vatAmount)} />
        <Stat label="Total" value={formatMoney(po.total)} accent />
        <Stat label="Outstanding" value={`${outstanding} units`} />
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <h3 className="card-title">Order lines</h3>
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>Description</th>
                <th>Budget line</th>
                <th className="right">Qty</th>
                <th>Unit</th>
                <th className="right">Unit price</th>
                <th className="right">Amount</th>
                <th className="right">Received</th>
                <th className="right">Outstanding</th>
              </tr>
            </thead>
            <tbody>
              {po.items.map((i) => (
                <tr key={i.id}>
                  <td>
                    <div>{i.description}</div>
                    {i.item && <div className="faint mono">{i.item.code}</div>}
                  </td>
                  <td>{i.costCategory?.name ?? <span className="faint">—</span>}</td>
                  <td className="right mono">{i.quantity}</td>
                  <td>{i.unit}</td>
                  <td className="right mono">{formatMoney(i.unitPrice)}</td>
                  <td className="right mono">{formatMoney(i.amount)}</td>
                  <td className="right mono">{i.receivedQty || <span className="faint">—</span>}</td>
                  <td className="right mono" style={{ color: i.outstandingQty > 0 ? 'var(--warn)' : undefined }}>
                    {i.outstandingQty || '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {po.receivings.length > 0 && (
        <div className="card">
          <h3 className="card-title">Receiving reports</h3>
          <div className="stack">
            {po.receivings.map((r) => (
              <Link key={r.id} to={`/g-chain/receiving/${r.id}`} className="row">
                <span className="mono">{r.number}</span>
                <span>{formatDate(r.receivedDate)}</span>
                <span className="faint">{r.receivedBy.name}</span>
              </Link>
            ))}
          </div>
        </div>
      )}

      {receiving && (
        <ReceiveModal
          po={po}
          onClose={() => setReceiving(false)}
          onReceived={(receivingId) => navigate(`/g-chain/receiving/${receivingId}`)}
        />
      )}
    </div>
  );
}

function Stat({ label: l, value, accent }: { label: string; value: React.ReactNode; accent?: boolean }) {
  return (
    <div className="card">
      <div className="faint" style={{ fontSize: 11, letterSpacing: 1 }}>
        {l.toUpperCase()}
      </div>
      <div style={{ fontSize: 18, marginTop: 6, fontWeight: 600, color: accent ? 'var(--neon)' : 'var(--text)' }}>
        {value}
      </div>
    </div>
  );
}

function ReceiveModal({
  po,
  onClose,
  onReceived,
}: {
  po: PoDetailData;
  onClose: () => void;
  onReceived: (id: string) => void;
}) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [warehouses, setWarehouses] = useState<{ id: string; name: string }[]>([]);
  const [warehouseId, setWarehouseId] = useState(po.warehouse?.id ?? '');
  const [deliveryRefNo, setDeliveryRefNo] = useState('');
  const [quantities, setQuantities] = useState<Record<string, string>>(() =>
    Object.fromEntries(po.items.map((i) => [i.id, String(i.outstandingQty)])),
  );

  useEffect(() => {
    api.get<typeof warehouses>('/warehouses').then(setWarehouses).catch(() => {});
  }, []);

  async function receive() {
    setBusy(true);
    setError(null);
    try {
      const created = await api.post<{ id: string }>('/receivings', {
        orderId: po.id,
        warehouseId: warehouseId || null,
        deliveryRefNo: deliveryRefNo || null,
        items: po.items
          .filter((i) => Number(quantities[i.id]) > 0)
          .map((i) => ({ orderItemId: i.id, quantity: Number(quantities[i.id]) })),
      });
      toast('ok', 'Goods received');
      onReceived(created.id);
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  }

  const receivingValue = po.items.reduce(
    (s, i) => s + (Number(quantities[i.id]) || 0) * i.unitPrice,
    0,
  );

  return (
    <Modal
      wide
      title={`Receive against ${po.number}`}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button className="btn btn-primary" onClick={receive} disabled={busy || receivingValue <= 0}>
            {busy ? 'Receiving…' : 'Receive'}
          </button>
        </>
      }
    >
      <ErrorBox error={error} />
      <div className="alert info">
        {po.kind === 'DIRECT_TO_JOB'
          ? `This charges ${po.job?.number ?? 'the project'} ${formatMoney(receivingValue)} and releases the same from committed.`
          : `This adds ${formatMoney(receivingValue)} of stock. No project is charged until it is issued.`}
      </div>

      <div className="grid grid-2">
        <Field label="Into warehouse" hint="Leave blank if it went straight to site">
          <select value={warehouseId} onChange={(e) => setWarehouseId(e.target.value)}>
            <option value="">— straight to site —</option>
            {warehouses.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Delivery receipt no.">
          <input value={deliveryRefNo} onChange={(e) => setDeliveryRefNo(e.target.value)} />
        </Field>
      </div>

      <div className="table-wrap">
        <table className="data">
          <thead>
            <tr>
              <th>Item</th>
              <th className="right">Ordered</th>
              <th className="right">Already in</th>
              <th className="right" style={{ width: 130 }}>
                Receiving now
              </th>
            </tr>
          </thead>
          <tbody>
            {po.items.map((i) => (
              <tr key={i.id}>
                <td>{i.description}</td>
                <td className="right mono">{i.quantity}</td>
                <td className="right mono faint">{i.receivedQty}</td>
                <td>
                  <input
                    className="mono"
                    type="number"
                    step="0.001"
                    max={i.outstandingQty}
                    style={{ textAlign: 'right', padding: '5px 7px' }}
                    value={quantities[i.id] ?? ''}
                    onChange={(e) => setQuantities({ ...quantities, [i.id]: e.target.value })}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="faint" style={{ fontSize: 12 }}>
        Receiving more than was ordered is refused — amend the order if the delivery is genuinely
        larger.
      </p>
    </Modal>
  );
}
