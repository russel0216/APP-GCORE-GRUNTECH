import { Fragment, useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, openPdf } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { DataList, type Column } from '../../components/DataList';
import { NumberInput } from '../../components/NumberInput';
import {
  Checkbox,
  ErrorBox,
  Field,
  Loading,
  StatusBadge,
  formatDate,
  formatMoney,
  useToast,
  type Tone,
} from '../../components/ui';
import { quotationTotals } from '../../lib/quotationMath';

/**
 * SALES ORDERS — SCORO's "Create invoice" under its real name: the document
 * that books a quotation's work in Gruntech operations. Raised from the
 * quotation page; numbered 4622, then 4622.1 for later orders on the same
 * quotation (progress booking). Internal: cost and margin show only to those
 * who may see cost, exactly as on the quotation.
 */

export const SO_TONES: Record<string, Tone> = { DRAFT: 'warn', ISSUED: 'ok' };

interface SoLine {
  id: string;
  group: string | null;
  title: string | null;
  description: string;
  isHeading: boolean;
  quantity: number;
  unit: string;
  unitPrice: number;
  amount: number;
  unitCost?: number | null;
  costAmount?: number | null;
  costNote?: string | null;
  margin?: number | null;
  marginPct?: number | null;
  providerSupplier?: { id: string; name: string } | null;
  providerUser?: { id: string; name: string } | null;
}

export interface SalesOrderRow {
  id: string;
  number: string;
  status: string;
  orderDate: string;
  termsDays: number;
  paymentMethod: string | null;
  referenceNo: string | null;
  poNumber: string | null;
  comment: string | null;
  siNumber: string | null;
  drNumber: string | null;
  cancelReason: string | null;
  discountPct: number;
  vatRate: number;
  vatInclusive: boolean;
  subtotal: number;
  discountAmount: number;
  net: number;
  vatAmount: number;
  total: number;
  customer: { id: string; code: string; name: string };
  contact: { id: string; name: string; position: string | null } | null;
  quotation: { id: string; number: string; subject: string };
  owner: { id: string; name: string };
  createdAt: string;
}

interface SalesOrderDetailRow extends SalesOrderRow {
  lines: SoLine[];
  canEdit: boolean;
  canSeeCost: boolean;
  costPanel?: { totalCost: number; inHouseCost: number; outsourcedCost: number; totalMargin: number };
}

export function SalesOrders() {
  const navigate = useNavigate();

  const columns: Column<SalesOrderRow>[] = [
    { key: 'number', label: 'Number', sortKey: 'number', width: '120px', render: (r) => <span className="mono">{r.number}</span> },
    {
      key: 'quotation',
      label: 'Quotation',
      render: (r) => (
        <div>
          <div>{r.quotation.subject}</div>
          <div className="faint mono">{r.quotation.number}</div>
        </div>
      ),
    },
    { key: 'customer', label: 'Customer', render: (r) => r.customer.name },
    { key: 'orderDate', label: 'Date', sortKey: 'orderDate', render: (r) => formatDate(r.orderDate) },
    { key: 'total', label: 'Total', sortKey: 'total', align: 'right', render: (r) => <span className="mono">{formatMoney(r.total)}</span> },
    { key: 'owner', label: 'Booked by', render: (r) => r.owner.name, optional: true },
    { key: 'status', label: 'Status', render: (r) => <StatusBadge status={r.status} extra={SO_TONES} /> },
  ];

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Sales Orders</h1>
          <p>
            What was won, booked into operations. A sales order is raised from its quotation — all of
            it, chosen lines, or one summary line — and later orders on the same quotation carry a
            .1, .2 suffix, so progress bookings stay one family.
          </p>
        </div>
      </div>

      <DataList<SalesOrderRow>
        listKey="sales-orders"
        endpoint="/sales-orders"
        columns={columns}
        rowKey={(r) => r.id}
        scoped
        searchPlaceholder="Search number, PO, customer, quotation…"
        onRowClick={(r) => navigate(`/g-ops/sales-orders/${r.id}`)}
        emptyTitle="Nothing booked yet"
        emptyHint="Open a quotation and press Create Sales Order — that is where one starts."
        filters={[
          {
            key: 'status',
            label: 'Status',
            options: [
              { value: 'DRAFT', label: 'Draft' },
              { value: 'ISSUED', label: 'Issued' },
              { value: 'CANCELLED', label: 'Cancelled' },
            ],
          },
        ]}
      />
    </div>
  );
}

// ── One order ────────────────────────────────────────────────────────────────

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="sales-row">
      <span className="sales-row-label">{label}</span>
      <span>{value ?? <span className="faint">—</span>}</span>
    </div>
  );
}

export function SalesOrderDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { can } = useAuth();
  const toast = useToast();
  const [order, setOrder] = useState<SalesOrderDetailRow | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [cancelling, setCancelling] = useState(false);
  const [cancelReason, setCancelReason] = useState('');
  const [removing, setRemoving] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    if (!id) return;
    try {
      setOrder(await api.get<SalesOrderDetailRow>(`/sales-orders/${id}`));
      setError(null);
    } catch (err) {
      setError(err);
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!order) return error ? <ErrorBox error={error} /> : <Loading />;

  async function act(run: () => Promise<unknown>, done: string) {
    setBusy(true);
    try {
      await run();
      toast('ok', done);
      await load();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  const showCost = order.canSeeCost;
  const draft = order.status === 'DRAFT';

  return (
    <div>
      <div className="breadcrumb">
        <Link to="/g-ops/sales-orders">Sales Orders</Link>
        <span className="sep">›</span>
        <span className="mono">{order.number}</span>
      </div>

      <div className="page-head">
        <div>
          <h1>
            Sales Order <span className="mono">{order.number}</span>
          </h1>
          <p>
            <StatusBadge status={order.status} extra={SO_TONES} />
            <span className="sales-after-badge">
              {order.customer.name} · per{' '}
              <Link to={`/g-ops/quotations/${order.quotation.id}`} className="mono">
                {order.quotation.number}
              </Link>{' '}
              · booked by {order.owner.name}
            </span>
          </p>
        </div>
        <div className="row">
          <button className="btn" onClick={() => openPdf(`/api/sales-orders/${order.id}/pdf`, () => setError(new Error('The PDF could not be made')))}>
            PDF
          </button>
          {order.canEdit && draft && (
            <Link className="btn" to={`/g-ops/sales-orders/${order.id}/edit`}>
              Modify
            </Link>
          )}
          {order.canEdit && draft && (
            <button className="btn btn-primary" disabled={busy} onClick={() => act(() => api.post(`/sales-orders/${order.id}/issue`), 'Issued — the sale is booked')}>
              Issue
            </button>
          )}
          {order.canEdit && order.status === 'ISSUED' && (
            <button className="btn" disabled={busy} onClick={() => act(() => api.post(`/sales-orders/${order.id}/reopen`), 'Back to draft')}>
              Reopen
            </button>
          )}
          {order.canEdit && order.status !== 'CANCELLED' && (
            <button className="btn btn-danger" onClick={() => setCancelling((v) => !v)}>
              Cancel order
            </button>
          )}
          {order.canEdit && draft && can('gops.sales_orders.delete') && (
            <button className="btn btn-danger" onClick={() => setRemoving((v) => !v)}>
              Delete
            </button>
          )}
        </div>
      </div>

      <ErrorBox error={error} />

      {cancelling && (
        <div className="alert warn row so-confirm">
          <span>Cancelling keeps the record and its number — say why:</span>
          <input value={cancelReason} onChange={(e) => setCancelReason(e.target.value)} aria-label="Why it is cancelled" />
          <button
            className="btn btn-sm btn-danger"
            disabled={busy || cancelReason.trim().length < 3}
            onClick={() =>
              act(() => api.post(`/sales-orders/${order.id}/cancel`, { reason: cancelReason.trim() }), 'Cancelled').then(() => setCancelling(false))
            }
          >
            Cancel this order
          </button>
          <button className="btn btn-sm" onClick={() => setCancelling(false)}>
            Keep it
          </button>
        </div>
      )}
      {removing && (
        <div className="alert warn row so-confirm">
          <span>Delete this draft for good? Its number is not reused.</span>
          <button
            className="btn btn-sm btn-danger"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await api.del(`/sales-orders/${order.id}`);
                toast('ok', 'Deleted');
                navigate('/g-ops/sales-orders');
              } catch (err) {
                setError(err);
                setBusy(false);
              }
            }}
          >
            Delete
          </button>
          <button className="btn btn-sm" onClick={() => setRemoving(false)}>
            Keep it
          </button>
        </div>
      )}
      {order.status === 'CANCELLED' && order.cancelReason && (
        <div className="alert warn">Cancelled — {order.cancelReason}</div>
      )}

      <div className="grid grid-2">
        <div className="card">
          <h3 className="card-title">Order</h3>
          <Row label="Customer" value={order.customer.name} />
          <Row label="Contact" value={order.contact ? `${order.contact.name}${order.contact.position ? `, ${order.contact.position}` : ''}` : null} />
          <Row
            label="Quotation"
            value={
              <Link to={`/g-ops/quotations/${order.quotation.id}`}>
                <span className="mono">{order.quotation.number}</span> — {order.quotation.subject}
              </Link>
            }
          />
          <Row label="Date of issue" value={formatDate(order.orderDate)} />
          <Row label="Payment terms" value={`${order.termsDays} days`} />
          <Row label="Payment method" value={order.paymentMethod} />
          <Row label="PO number" value={order.poNumber} />
          <Row label="Reference" value={order.referenceNo} />
          {order.comment && <Row label="Notes" value={order.comment} />}
        </div>
        <ReleaseCard order={order} onSaved={load} />
      </div>

      <div className="card sales-card-gap">
        <h3 className="card-title">Lines</h3>
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>Group</th>
                <th>Product and description</th>
                <th className="right">Qty</th>
                <th className="right">Unit price</th>
                <th className="right">Amount</th>
                {showCost && <th className="right">Cost + provider</th>}
                {showCost && <th className="right">Margin</th>}
              </tr>
            </thead>
            <tbody>
              {order.lines.map((l) =>
                l.isHeading ? (
                  <tr key={l.id} className="so-heading">
                    <td colSpan={showCost ? 7 : 5}>{l.title}</td>
                  </tr>
                ) : (
                  <tr key={l.id}>
                    <td className="faint">{l.group ?? ''}</td>
                    <td>
                      {l.title && <div className="qe-title">{l.title}</div>}
                      {l.description && <div className={l.title ? 'faint' : ''}>{l.description}</div>}
                    </td>
                    <td className="right mono">
                      {l.quantity} {l.unit}
                    </td>
                    <td className="right mono">{formatMoney(l.unitPrice)}</td>
                    <td className="right mono">{formatMoney(l.amount)}</td>
                    {showCost && (
                      <td className="right mono">
                        {l.costAmount == null ? <span className="faint">—</span> : formatMoney(l.costAmount)}
                        {(l.providerSupplier || l.providerUser) && (
                          <div className="faint">{l.providerSupplier?.name ?? l.providerUser?.name}</div>
                        )}
                      </td>
                    )}
                    {showCost && (
                      <td className="right mono">{l.margin == null ? <span className="faint">—</span> : formatMoney(l.margin)}</td>
                    )}
                  </tr>
                ),
              )}
            </tbody>
          </table>
        </div>

        <div className="so-totals-wrap">
          <dl className="so-totals">
            <dt>Subtotal</dt>
            <dd className="mono">{formatMoney(order.subtotal)}</dd>
            {order.discountAmount > 0 && (
              <>
                <dt>Discount ({order.discountPct}%)</dt>
                <dd className="mono">-{formatMoney(order.discountAmount)}</dd>
              </>
            )}
            <dt>{order.vatInclusive ? `VAT included (${(order.vatRate * 100).toFixed(0)}%)` : `Tax (${(order.vatRate * 100).toFixed(0)}%)`}</dt>
            <dd className="mono">{formatMoney(order.vatAmount)}</dd>
            <dt className="so-grand">Total (PHP)</dt>
            <dd className="mono so-grand">{formatMoney(order.total)}</dd>
          </dl>
          {showCost && order.costPanel && (
            <dl className="so-totals">
              <dt>Total cost</dt>
              <dd className="mono">{formatMoney(order.costPanel.totalCost)}</dd>
              <dt>In-house</dt>
              <dd className="mono">{formatMoney(order.costPanel.inHouseCost)}</dd>
              <dt>Outsourced</dt>
              <dd className="mono">{formatMoney(order.costPanel.outsourcedCost)}</dd>
              <dt className="so-grand">Total margin</dt>
              <dd className="mono so-grand">{formatMoney(order.costPanel.totalMargin)}</dd>
            </dl>
          )}
        </div>
      </div>
    </div>
  );
}

/** SI / BS and DR numbers — filled at release, editable while the order lives. */
function ReleaseCard({ order, onSaved }: { order: SalesOrderDetailRow; onSaved: () => Promise<void> }) {
  const toast = useToast();
  const [si, setSi] = useState(order.siNumber ?? '');
  const [dr, setDr] = useState(order.drNumber ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const editable = order.canEdit && order.status !== 'CANCELLED';

  return (
    <div className="card">
      <h3 className="card-title">Released by</h3>
      <p className="faint">The sales invoice / billing statement and delivery receipt this order went out under.</p>
      <ErrorBox error={error} />
      <div className="grid grid-2">
        <Field label="SI / BS No.">
          <input value={si} disabled={!editable} onChange={(e) => setSi(e.target.value)} />
        </Field>
        <Field label="DR No.">
          <input value={dr} disabled={!editable} onChange={(e) => setDr(e.target.value)} />
        </Field>
      </div>
      {editable && (si !== (order.siNumber ?? '') || dr !== (order.drNumber ?? '')) && (
        <button
          className="btn btn-sm"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            setError(null);
            try {
              await api.patch(`/sales-orders/${order.id}`, { siNumber: si.trim() || null, drNumber: dr.trim() || null });
              toast('ok', 'Release references saved');
              await onSaved();
            } catch (err) {
              setError(err);
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? 'Saving…' : 'Save references'}
        </button>
      )}
    </div>
  );
}

// ── The editor — SCORO's invoice edit screen, as a page ──────────────────────

interface EditLine {
  key: string;
  id?: string;
  isHeading: boolean;
  group: string;
  title: string;
  description: string;
  quantity: string;
  unit: string;
  unitPrice: string;
  unitCost: string;
  costNote: string;
}

let lineKey = 0;
const freshKey = () => `so-${++lineKey}`;

export function SalesOrderEditor() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const toast = useToast();
  const [order, setOrder] = useState<SalesOrderDetailRow | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [lines, setLines] = useState<EditLine[]>([]);
  const [groups, setGroups] = useState<string[]>([]);
  const [header, setHeader] = useState({
    orderDate: '',
    termsDays: '30',
    paymentMethod: '',
    referenceNo: '',
    poNumber: '',
    comment: '',
    discountPct: '0',
    vatInclusive: false,
  });

  useEffect(() => {
    api
      .get<{ name: string }[]>('/reference/quotation-groups?active=true')
      .then((rows) => setGroups(rows.map((g) => g.name)))
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (!id) return;
    api
      .get<SalesOrderDetailRow>(`/sales-orders/${id}`)
      .then((o) => {
        setOrder(o);
        setHeader({
          orderDate: o.orderDate.slice(0, 10),
          termsDays: String(o.termsDays),
          paymentMethod: o.paymentMethod ?? '',
          referenceNo: o.referenceNo ?? '',
          poNumber: o.poNumber ?? '',
          comment: o.comment ?? '',
          discountPct: String(o.discountPct),
          vatInclusive: o.vatInclusive,
        });
        setLines(
          o.lines.map((l) => ({
            key: freshKey(),
            id: l.id,
            isHeading: l.isHeading,
            group: l.group ?? '',
            title: l.title ?? '',
            description: l.description,
            quantity: String(l.quantity),
            unit: l.unit,
            unitPrice: String(l.unitPrice),
            unitCost: l.unitCost == null ? '' : String(l.unitCost),
            costNote: l.costNote ?? '',
          })),
        );
      })
      .catch(setError);
  }, [id]);

  if (!order) return error ? <ErrorBox error={error} /> : <Loading />;
  if (!order.canEdit || order.status !== 'DRAFT') {
    return (
      <div className="card">
        <h3 className="card-title">{order.number} cannot be modified</h3>
        <p className="muted">
          {order.status !== 'DRAFT' ? `It is ${order.status.toLowerCase()} — reopen it first.` : 'Only its author can edit it.'}
        </p>
        <Link className="btn" to={`/g-ops/sales-orders/${order.id}`}>
          Back to {order.number}
        </Link>
      </div>
    );
  }

  const showCost = order.canSeeCost;
  const n = (v: string) => Number(v) || 0;
  const totals = quotationTotals({
    lines: lines
      .filter((l) => !l.isHeading)
      .map((l) => ({ amount: n(l.quantity) * n(l.unitPrice), costAmount: l.unitCost === '' ? undefined : n(l.quantity) * n(l.unitCost) })),
    discountPct: n(header.discountPct),
    vatRate: order.vatRate,
    vatInclusive: header.vatInclusive,
  });

  function update(key: string, patch: Partial<EditLine>) {
    setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  }

  async function save() {
    setBusy(true);
    setError(null);
    try {
      await api.put(`/sales-orders/${order!.id}`, {
        orderDate: header.orderDate,
        termsDays: Number(header.termsDays) || 0,
        paymentMethod: header.paymentMethod.trim() || null,
        referenceNo: header.referenceNo.trim() || null,
        poNumber: header.poNumber.trim() || null,
        comment: header.comment.trim() || null,
        discountPct: n(header.discountPct),
        vatInclusive: header.vatInclusive,
        lines: lines
          .filter((l) => (l.isHeading ? l.title.trim() : l.title.trim() || l.description.trim()))
          .map((l) =>
            l.isHeading
              ? { isHeading: true, title: l.title.trim() }
              : {
                  group: l.group.trim() || null,
                  title: l.title.trim() || null,
                  description: l.description,
                  quantity: n(l.quantity),
                  unit: l.unit.trim() || 'lot',
                  unitPrice: n(l.unitPrice),
                  ...(showCost ? { unitCost: l.unitCost === '' ? null : n(l.unitCost), costNote: l.costNote.trim() || null } : {}),
                },
          ),
      });
      toast('ok', `Saved ${order!.number}`);
      navigate(`/g-ops/sales-orders/${order!.id}`);
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  }

  return (
    <div className="qe">
      <div className="breadcrumb">
        <Link to="/g-ops/sales-orders">Sales Orders</Link>
        <span className="sep">›</span>
        <Link to={`/g-ops/sales-orders/${order.id}`} className="mono">
          {order.number}
        </Link>
        <span className="sep">›</span>
        <span>Modify</span>
      </div>

      <section className="card qe-card">
        <div className="qe-head">
          <div>
            <h1 className="qe-heading">Sales order details</h1>
            <p className="faint qe-lead">Nothing changes until you save.</p>
          </div>
          <div className="row qe-actions">
            <Link className="btn" to={`/g-ops/sales-orders/${order.id}`}>
              Back
            </Link>
            <button className="btn btn-primary" onClick={() => void save()} disabled={busy}>
              {busy ? 'Saving…' : 'Save'}
            </button>
          </div>
        </div>
        <ErrorBox error={error} />

        <div className="grid grid-3">
          <Field label="Date of issue">
            <input type="date" value={header.orderDate} onChange={(e) => setHeader({ ...header, orderDate: e.target.value })} />
          </Field>
          <Field label="Payment terms (days)">
            <NumberInput kind="count" min={0} max={365} value={header.termsDays} onChange={(e) => setHeader({ ...header, termsDays: e.target.value })} />
          </Field>
          <Field label="Payment method">
            <input value={header.paymentMethod} placeholder="e.g. Bank transfer" onChange={(e) => setHeader({ ...header, paymentMethod: e.target.value })} />
          </Field>
          <Field label="Purchase order number" hint="The customer's PO this books against">
            <input value={header.poNumber} onChange={(e) => setHeader({ ...header, poNumber: e.target.value })} />
          </Field>
          <Field label="Reference number">
            <input value={header.referenceNo} onChange={(e) => setHeader({ ...header, referenceNo: e.target.value })} />
          </Field>
          <Field label="Discount %">
            <NumberInput kind="percent" min={0} max={100} value={header.discountPct} onChange={(e) => setHeader({ ...header, discountPct: e.target.value })} />
          </Field>
        </div>
        <Field label="Notes" hint="Printed on the order">
          <textarea rows={2} value={header.comment} onChange={(e) => setHeader({ ...header, comment: e.target.value })} />
        </Field>

        <div className="table-wrap so-edit-lines">
          <table className="data">
            <thead>
              <tr>
                <th className="so-col-group">Group</th>
                <th>Product and description</th>
                <th className="so-col-qty">Qty</th>
                <th className="so-col-unit">Unit</th>
                <th className="so-col-money">Unit price</th>
                <th className="right">Amount</th>
                {showCost && <th className="so-col-money">Unit cost</th>}
                {showCost && <th className="right">Margin</th>}
                <th className="so-col-x" />
              </tr>
            </thead>
            <tbody>
              {lines.map((l, i) => {
                const label = l.isHeading ? `Subheading ${i + 1}` : `Line ${i + 1}`;
                if (l.isHeading) {
                  return (
                    <tr key={l.key} className="so-heading">
                      <td colSpan={showCost ? 8 : 6}>
                        <input
                          className="qe-title"
                          aria-label={`${label} text`}
                          placeholder="Subheading"
                          value={l.title}
                          onChange={(e) => update(l.key, { title: e.target.value })}
                        />
                      </td>
                      <td className="so-col-x">
                        <button className="btn btn-ghost btn-sm" aria-label={`Remove ${label}`} onClick={() => setLines((ls) => ls.filter((x) => x.key !== l.key))}>
                          ✕
                        </button>
                      </td>
                    </tr>
                  );
                }
                const amount = n(l.quantity) * n(l.unitPrice);
                const margin = l.unitCost === '' ? null : amount - n(l.quantity) * n(l.unitCost);
                return (
                  <Fragment key={l.key}>
                    <tr>
                      <td className="so-col-group">
                        <input aria-label={`${label} group`} list="so-groups" value={l.group} onChange={(e) => update(l.key, { group: e.target.value })} />
                      </td>
                      <td>
                        <input
                          className="qe-title"
                          aria-label={`${label} product`}
                          placeholder="Product"
                          value={l.title}
                          onChange={(e) => update(l.key, { title: e.target.value })}
                        />
                        <textarea
                          rows={2}
                          aria-label={`${label} description`}
                          placeholder="Additional info"
                          value={l.description}
                          onChange={(e) => update(l.key, { description: e.target.value })}
                        />
                      </td>
                      <td className="so-col-qty">
                        <NumberInput kind="quantity" aria-label={`${label} quantity`} value={l.quantity} onChange={(e) => update(l.key, { quantity: e.target.value })} />
                      </td>
                      <td className="so-col-unit">
                        <input aria-label={`${label} unit`} value={l.unit} onChange={(e) => update(l.key, { unit: e.target.value })} />
                      </td>
                      <td className="so-col-money">
                        <NumberInput kind="money" aria-label={`${label} unit price`} value={l.unitPrice} onChange={(e) => update(l.key, { unitPrice: e.target.value })} />
                      </td>
                      <td className="right mono">{formatMoney(amount)}</td>
                      {showCost && (
                        <td className="so-col-money">
                          <NumberInput kind="money" aria-label={`${label} unit cost`} placeholder="0.00" value={l.unitCost} onChange={(e) => update(l.key, { unitCost: e.target.value })} />
                          <input
                            aria-label={`${label} cost note`}
                            placeholder="Notes"
                            value={l.costNote}
                            onChange={(e) => update(l.key, { costNote: e.target.value })}
                          />
                        </td>
                      )}
                      {showCost && <td className="right mono">{margin == null ? '—' : formatMoney(margin)}</td>}
                      <td className="so-col-x">
                        <button className="btn btn-ghost btn-sm" aria-label={`Remove ${label}`} onClick={() => setLines((ls) => ls.filter((x) => x.key !== l.key))}>
                          ✕
                        </button>
                      </td>
                    </tr>
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
        <datalist id="so-groups">
          {[...new Set([...groups, ...lines.map((l) => l.group.trim()).filter(Boolean)])].map((g) => (
            <option key={g} value={g} />
          ))}
        </datalist>
        <div className="row so-add">
          <button
            className="btn btn-sm"
            onClick={() =>
              setLines((ls) => [...ls, { key: freshKey(), isHeading: true, group: '', title: '', description: '', quantity: '0', unit: 'lot', unitPrice: '0', unitCost: '', costNote: '' }])
            }
          >
            Add subheading
          </button>
          <button
            className="btn btn-sm"
            onClick={() =>
              setLines((ls) => [...ls, { key: freshKey(), isHeading: false, group: '', title: '', description: '', quantity: '1', unit: 'lot', unitPrice: '0', unitCost: '', costNote: '' }])
            }
          >
            Add row
          </button>
        </div>

        <div className="so-totals-wrap">
          <dl className="so-totals">
            <dt>Subtotal</dt>
            <dd className="mono">{formatMoney(totals.subtotal)}</dd>
            {totals.discountAmount > 0 && (
              <>
                <dt>Discount</dt>
                <dd className="mono">-{formatMoney(totals.discountAmount)}</dd>
                <dt>Sum without tax</dt>
                <dd className="mono">{formatMoney(totals.netOfTax)}</dd>
              </>
            )}
            <dt>{header.vatInclusive ? `VAT included (${(order.vatRate * 100).toFixed(0)}%)` : `Tax (${(order.vatRate * 100).toFixed(0)}%)`}</dt>
            <dd className="mono">{formatMoney(totals.vatAmount)}</dd>
            <dt className="so-grand">Total (PHP)</dt>
            <dd className="mono so-grand">{formatMoney(totals.total)}</dd>
          </dl>
          {showCost && (
            <dl className="so-totals">
              <dt>Total cost</dt>
              <dd className="mono">{formatMoney(totals.cost.totalCost)}</dd>
              <dt className="so-grand">Total margin</dt>
              <dd className="mono so-grand">{formatMoney(totals.cost.totalMargin)}</dd>
            </dl>
          )}
        </div>
        <Checkbox checked={header.vatInclusive} onChange={(v) => setHeader({ ...header, vatInclusive: v })} label="Prices include VAT" />
      </section>
    </div>
  );
}
