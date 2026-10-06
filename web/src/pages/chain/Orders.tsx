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
  StatusBadge,
  formatDate,
  formatMoney,
  useToast,
} from '../../components/ui';
import { Stat } from '../../components/charts';
import { DocumentApproval } from '../../components/ApprovalStepper';
import { RecordHeader } from '../../components/RecordHeader';
import { ProgressBar } from '../delivery/Projects';
import { openPdf } from '../../lib/api';
import { NumberInput } from '../../components/NumberInput';

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
      render: (c) => <StatusBadge status={c.status} extra={{ AWARDED: 'ok' }} />,
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
            <span className="proc-pill-gap">
              <StatusBadge status={canvass.status} extra={{ AWARDED: 'ok' }} />
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
                      <Link to={`/g-chain/suppliers/${s.supplier.id}`}>{s.supplier.name}</Link>
                      {s.isSelected && <span className="badge ok proc-pill-gap">awarded</span>}
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
                            className={`right mono${price !== undefined && price === best ? ' proc-best' : ''}`}
                            title={price !== undefined && price === best ? 'Lowest quote for this line' : undefined}
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
                      className={`right mono${s.id === canvass.lowestSupplierId ? ' proc-best' : ''}`}
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
                        <div className="proc-row-actions">
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
          <div className="alert info proc-card-note">
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
          <NumberInput
            kind="count"
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
      <p className="muted">
        Leave a line blank if they did not quote it. An incomplete quote is excluded from the
        lowest-total comparison, because it is not a like-for-like offer.
      </p>
      <div className="table-wrap">
        <table className="data">
          <thead>
            <tr>
              <th>Item</th>
              <th className="right">Qty</th>
              <th className="right proc-col-input">Unit price</th>
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
                  <NumberInput
                    kind="money"
                    step="0.01"
                    className="mono proc-cell-input"
                    aria-label={`Unit price for ${i.description}`}
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
      render: (o) => <StatusBadge status={o.status} />,
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
          // The G-CHAIN dashboard's "Orders awaiting delivery" opens this —
          // issued or part-received, the pair it counts.
          { key: 'awaiting', label: 'Delivery', options: [{ value: 'true', label: 'Awaiting delivery' }] },
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
  items: PoLine[];
  receivings: { id: string; number: string; receivedDate: string; receivedBy: { name: string } }[];
  /** Empty unless the caller holds gfin.ap.view_all — see `billsVisible`. */
  bills: { id: string; number: string; status: string; total: number; dueDate: string }[];
  billsVisible: boolean;
  /** DRAFT and the caller may change it (edit_all, or its author with edit_own). */
  canEdit: boolean;
  /** Placed from this awarded canvass: the supplier is decided. */
  fromCanvass: { id: string; number: string } | null;
  /** The approver's reason, when the latest submission was rejected back to draft. */
  returned: { by: string | null; comment: string | null; at: string | null } | null;
}

interface PoLine {
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
  const [modifying, setModifying] = useState(false);
  /** A line being edited, or 'new' for "+ Add line". */
  const [lineEditing, setLineEditing] = useState<PoLine | 'new' | null>(null);
  // Bumped on every load so the approval chain re-reads after a submit.
  const [reload, setReload] = useState(0);

  const load = useCallback(async () => {
    if (!id) return;
    try {
      setPo(await api.get<PoDetailData>(`/purchase-orders/${id}`));
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

  async function removeLine(line: PoLine) {
    if (!po) return;
    try {
      await api.del(`/purchase-orders/${po.id}/items/${line.id}`);
      toast('ok', 'Line removed');
      await load();
    } catch (err) {
      setError(err);
    }
  }

  const outstanding = po.items.reduce((s, i) => s + i.outstandingQty, 0);
  const isDraft = po.status === 'DRAFT';
  const billable = ['ISSUED', 'PARTIALLY_RECEIVED', 'RECEIVED'].includes(po.status);

  const addLineButton = po.canEdit ? (
    <button className="btn btn-primary btn-sm" onClick={() => setLineEditing('new')}>
      + Add line
    </button>
  ) : null;

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

      <RecordHeader
        type="Purchase Order"
        code={po.number}
        title={po.supplier.name}
        status={po.status}
        amount={formatMoney(po.total)}
        amountLabel="Order total"
        actions={
          <>
            <button
              className="btn"
              onClick={() => openPdf(`/api/purchase-orders/${po.id}/pdf`, () => toast('error', 'Could not print'))}
            >
              Print
            </button>
            {po.canEdit && (
              <button className="btn" onClick={() => setModifying(true)}>
                Modify
              </button>
            )}
            {isDraft && can('gchain.purchase_orders.create') && po.items.length > 0 && (
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
          </>
        }
      />

      <p className="record-head-meta proc-meta">
        <Link to={`/g-chain/suppliers/${po.supplier.id}`}>{po.supplier.name}</Link> ·{' '}
        {po.job ? (
          <Link to={`/g-ops/projects/${po.job.id}`}>
            {po.job.number} — {po.job.name}
          </Link>
        ) : (
          `Stock replenishment${po.warehouse ? ` for ${po.warehouse.name}` : ''}`
        )}{' '}
        · ordered {formatDate(po.orderDate)}
        {po.deliveryDate ? ` · required by ${formatDate(po.deliveryDate)}` : ''}
        {po.fromCanvass && (
          <>
            {' '}
            · awarded on <Link to={`/g-chain/canvass/${po.fromCanvass.id}`}>{po.fromCanvass.number}</Link>
          </>
        )}
      </p>

      <DocumentApproval documentType="purchase_order" documentId={po.id} reloadToken={reload} />

      <ErrorBox error={error} />

      {isDraft && po.returned && (
        <div className="alert error" role="status">
          <strong>Returned by {po.returned.by ?? 'the approver'}</strong>
          {po.returned.comment ? `: ${po.returned.comment}` : ' — no reason was given.'} Change what
          they asked for, then submit it again.
        </div>
      )}
      {isDraft && po.request && po.items.length > 0 && (
        <div className="alert info">
          Lines came over from {po.request.number} at its <strong>estimated</strong> prices. Set each
          one to the price actually agreed with {po.supplier.name} before submitting — the approved
          order is what commits the budget.
        </div>
      )}
      {po.status === 'PENDING_APPROVAL' && (
        <div className="alert info">With the approvers. It cannot be changed until they decide.</div>
      )}

      {po.status === 'ISSUED' && po.kind === 'DIRECT_TO_JOB' && (
        <div className="alert ok">
          Issued — {formatMoney(po.subtotal)} is committed against the project at the agreed price.
          The request's estimate has been released, so it is not counted twice.
        </div>
      )}

      <div className="kpi-grid proc-stats">
        <Stat label="Subtotal" value={formatMoney(po.subtotal)} figure />
        <Stat
          label={`VAT ${(po.vatRate * 100).toFixed(0)}%`}
          value={formatMoney(po.vatAmount)}
          sub={po.vatInclusive ? 'included in the prices' : 'added to the prices'}
          figure
        />
        <Stat label="Total" value={formatMoney(po.total)} accent="neon" figure />
        <Stat
          label="Outstanding"
          value={`${outstanding} units`}
          sub={outstanding > 0 && !isDraft ? 'still to be delivered' : undefined}
          figure
        />
      </div>

      <div className="card proc-card">
        <div className="proc-card-head">
          <h3 className="card-title">Order lines</h3>
          {po.items.length > 0 && addLineButton}
        </div>
        {po.items.length === 0 ? (
          <Empty
            title="No lines yet"
            hint={
              po.canEdit
                ? 'An order cannot be submitted empty. Add what is being bought, at the agreed price.'
                : 'Nothing has been added to this order.'
            }
            action={addLineButton ?? undefined}
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
                <th className="right">Unit price</th>
                <th className="right">Amount</th>
                <th className="right">Received</th>
                <th className="right">Outstanding</th>
                {po.canEdit && <th className="proc-col-actions" aria-label="Actions" />}
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
                  <td className={`right mono${i.outstandingQty > 0 && !isDraft ? ' proc-short' : ''}`}>
                    {i.outstandingQty || '—'}
                  </td>
                  {po.canEdit && (
                    <td>
                      <div className="proc-row-actions">
                        <button
                          className="btn btn-ghost btn-sm"
                          aria-label={`Modify ${i.description}`}
                          onClick={() => setLineEditing(i)}
                        >
                          Modify
                        </button>
                        <button
                          className="btn btn-ghost btn-sm"
                          aria-label={`Remove ${i.description}`}
                          onClick={() => void removeLine(i)}
                        >
                          Remove
                        </button>
                      </div>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        )}
      </div>

      {(po.receivings.length > 0 || (po.billsVisible && (po.bills.length > 0 || billable))) && (
        <div className="grid grid-2">
          {po.receivings.length > 0 && (
            <div className="card">
              <h3 className="card-title">Receiving reports</h3>
              <div className="proc-links">
                {po.receivings.map((r) => (
                  <Link key={r.id} to={`/g-chain/receiving/${r.id}`} className="proc-link-row">
                    <span className="mono">{r.number}</span>
                    <span>{formatDate(r.receivedDate)}</span>
                    <span className="faint">{r.receivedBy.name}</span>
                  </Link>
                ))}
              </div>
            </div>
          )}
          {po.billsVisible && (po.bills.length > 0 || billable) && (
            <div className="card">
              <h3 className="card-title">Supplier bills</h3>
              {po.bills.length === 0 ? (
                <Empty
                  title="Not billed yet"
                  hint="Enter the supplier's invoice from the receiving report it covers."
                />
              ) : (
                <div className="proc-links">
                  {po.bills.map((b) => (
                    <Link key={b.id} to={`/g-fin/ap/${b.id}`} className="proc-link-row">
                      <span className="mono">{b.number}</span>
                      <StatusBadge status={b.status} />
                      <span className="faint">due {formatDate(b.dueDate)}</span>
                      <span className="mono proc-push">{formatMoney(b.total)}</span>
                    </Link>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {modifying && (
        <PoHeaderModal
          po={po}
          onClose={() => setModifying(false)}
          onSaved={() => {
            setModifying(false);
            toast('ok', 'Order updated');
            void load();
          }}
        />
      )}

      {lineEditing && (
        <PoLineModal
          po={po}
          line={lineEditing === 'new' ? null : lineEditing}
          onClose={() => setLineEditing(null)}
          onSaved={() => {
            setLineEditing(null);
            void load();
          }}
        />
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

/** A date from the API as the `YYYY-MM-DD` a date input wants. */
function dateInput(value: string | null): string {
  return value ? value.slice(0, 10) : '';
}

/**
 * The order header, while it is still a draft.
 *
 * The supplier is fixed when the order came from an awarded canvass — the
 * prices on it are that supplier's quote, and the server refuses the swap.
 */
function PoHeaderModal({
  po,
  onClose,
  onSaved,
}: {
  po: PoDetailData;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [suppliers, setSuppliers] = useState<{ id: string; name: string }[]>([]);
  const [form, setForm] = useState({
    supplierId: po.supplier.id,
    deliveryDate: dateInput(po.deliveryDate),
    terms: po.terms ?? '',
    deliverTo: po.deliverTo ?? '',
    notes: po.notes ?? '',
    vatInclusive: po.vatInclusive,
  });

  useEffect(() => {
    api.get<typeof suppliers>('/suppliers/lookup').then(setSuppliers).catch(() => {});
  }, []);

  async function save() {
    setBusy(true);
    setError(null);
    try {
      await api.patch(`/purchase-orders/${po.id}`, {
        ...(po.fromCanvass ? {} : { supplierId: form.supplierId }),
        deliveryDate: form.deliveryDate || null,
        terms: form.terms || null,
        deliverTo: form.deliverTo || null,
        notes: form.notes || null,
        vatInclusive: form.vatInclusive,
      });
      onSaved();
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  }

  // The current supplier stays pickable even if the lookup omits it.
  const options = suppliers.some((s) => s.id === po.supplier.id)
    ? suppliers
    : [{ id: po.supplier.id, name: po.supplier.name }, ...suppliers];

  return (
    <Modal
      title={`Modify ${po.number}`}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button className="btn btn-primary" onClick={save} disabled={busy || !form.supplierId}>
            {busy ? 'Saving…' : 'Save'}
          </button>
        </>
      }
    >
      <ErrorBox error={error} />
      <Field
        label="Supplier"
        hint={po.fromCanvass ? `Awarded on ${po.fromCanvass.number} — raise a new canvass to change it` : undefined}
      >
        <select
          value={form.supplierId}
          disabled={!!po.fromCanvass}
          onChange={(e) => setForm({ ...form, supplierId: e.target.value })}
        >
          {options.map((s) => (
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
        <Field label="Terms" hint={po.supplier.paymentTerms ? `Supplier default: ${po.supplier.paymentTerms}` : undefined}>
          <input value={form.terms} onChange={(e) => setForm({ ...form, terms: e.target.value })} />
        </Field>
      </div>
      <Field label="Deliver to" hint={po.warehouse ? `Blank prints ${po.warehouse.name}` : 'Site address, or blank'}>
        <input value={form.deliverTo} onChange={(e) => setForm({ ...form, deliverTo: e.target.value })} />
      </Field>
      <Field label="Notes">
        <textarea rows={3} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
      </Field>
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

/**
 * Add or modify one order line.
 *
 * A direct-to-job line must name its budget line — the server refuses one
 * without, because that is how the committed cost finds its category.
 */
function PoLineModal({
  po,
  line,
  onClose,
  onSaved,
}: {
  po: PoDetailData;
  line: PoLine | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [items, setItems] = useState<
    { id: string; code: string; name: string; unit: string; standardCost: string | number | null }[]
  >([]);
  const [categories, setCategories] = useState<{ id: string; name: string }[]>([]);
  const [form, setForm] = useState({
    itemId: line?.item?.id ?? '',
    costCategoryId: line?.costCategory?.id ?? '',
    description: line?.description ?? '',
    quantity: line ? String(line.quantity) : '1',
    unit: line?.unit ?? 'pcs',
    unitPrice: line ? String(line.unitPrice) : '',
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
      unitPrice: item?.standardCost != null && !f.unitPrice ? String(item.standardCost) : f.unitPrice,
    }));
  }

  const direct = po.kind === 'DIRECT_TO_JOB';
  const needsCategory = direct && !form.costCategoryId;
  const quantity = Number(form.quantity);
  const price = Number(form.unitPrice || 0);
  const valid = !!form.description.trim() && quantity > 0 && price >= 0 && !needsCategory;

  async function save() {
    setBusy(true);
    setError(null);
    const body = {
      itemId: form.itemId || null,
      costCategoryId: form.costCategoryId || null,
      description: form.description.trim(),
      quantity,
      unit: form.unit.trim() || 'pcs',
      unitPrice: price,
    };
    try {
      if (line) await api.patch(`/purchase-orders/${po.id}/items/${line.id}`, body);
      else await api.post(`/purchase-orders/${po.id}/items`, body);
      onSaved();
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  }

  return (
    <Modal
      title={line ? 'Modify line' : 'Add a line'}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button
            className="btn btn-primary"
            onClick={save}
            disabled={busy || !valid}
            title={needsCategory ? 'Choose the budget line first' : undefined}
          >
            {busy ? 'Saving…' : line ? 'Save' : 'Add'}
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
      {direct && (
        <Field label="Budget line" hint="Required — which part of the project budget this is charged to">
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
            min="0"
            value={form.quantity}
            onChange={(e) => setForm({ ...form, quantity: e.target.value })}
          />
        </Field>
        <Field label="Unit">
          <input value={form.unit} onChange={(e) => setForm({ ...form, unit: e.target.value })} />
        </Field>
        <Field label="Unit price" hint="The price agreed with the supplier">
          <NumberInput
            kind="money"
            step="0.01"
            min="0"
            value={form.unitPrice}
            onChange={(e) => setForm({ ...form, unitPrice: e.target.value })}
          />
        </Field>
      </div>
      <div className="alert info proc-card-note">
        Line amount: <strong>{formatMoney((quantity || 0) * price)}</strong>
        {po.vatInclusive ? ' (VAT included)' : ' before VAT'}
      </div>
    </Modal>
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
              <th className="right proc-col-input">Receiving now</th>
            </tr>
          </thead>
          <tbody>
            {po.items.map((i) => (
              <tr key={i.id}>
                <td>{i.description}</td>
                <td className="right mono">{i.quantity}</td>
                <td className="right mono faint">{i.receivedQty}</td>
                <td>
                  <NumberInput
                    kind="quantity"
                    className="mono proc-cell-input"
                    step="0.001"
                    max={i.outstandingQty}
                    aria-label={`Quantity received of ${i.description}`}
                    value={quantities[i.id] ?? ''}
                    onChange={(e) => setQuantities({ ...quantities, [i.id]: e.target.value })}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="faint proc-small">
        Receiving more than was ordered is refused — amend the order if the delivery is genuinely
        larger.
      </p>
    </Modal>
  );
}
