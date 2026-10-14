import { useCallback, useEffect, useState } from 'react';
import { Link, Navigate, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { DataList, type Column } from '../../components/DataList';
import {
  Empty,
  ErrorBox,
  Field,
  Loading,
  Modal,
  ModalFoot,
  StatusBadge,
  formatDate,
  formatMoney,
  useToast,
} from '../../components/ui';
import { Stat } from '../../components/charts';
import { DocumentApproval } from '../../components/ApprovalStepper';
import { RecordHeader } from '../../components/RecordHeader';
import { ProgressBar } from '../delivery/Projects';
import { NumberInput } from '../../components/NumberInput';

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
  const [params] = useSearchParams();
  // An old `?fromRequest=` / `?fromCanvass=` link opens the order page with the same preset.
  if (params.has('fromRequest') || params.has('fromCanvass')) {
    return <Navigate to={`/g-chain/purchase-orders/new?${params.toString()}`} replace />;
  }

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
        </div>
      </div>

      <DataList<PoRow>
        listKey="purchase-orders"
        endpoint="/purchase-orders"
        printPath="/api/purchase-orders/pdf"
        columns={columns}
        rowKey={(o) => o.id}
        searchPlaceholder="Search number, supplier, project…"
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
            <Link className="btn btn-primary btn-sm" to="/g-chain/purchase-orders/new">
              + New purchase order
            </Link>
          ) : null
        }
      />

    </div>
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
  receivings: { id: string; number: string; status: string; receivedDate: string; receivedBy: { name: string } }[];
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
  name: string | null;
  partNumber: string | null;
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

  const outstanding = po.items.reduce((s, i) => s + i.outstandingQty, 0);
  const isDraft = po.status === 'DRAFT';
  const billable = ['ISSUED', 'PARTIALLY_RECEIVED', 'RECEIVED'].includes(po.status);
  // The API's own rule: a draft with nothing received against it.
  const mayDelete = isDraft && po.receivings.length === 0 && can('gchain.purchase_orders.delete');

  /** Asked in the confirm bar, which shows a refusal — so this throws rather than catching. */
  async function remove() {
    if (!po) return;
    await api.del(`/purchase-orders/${po.id}`);
    toast('ok', `${po.number} deleted`);
    navigate('/g-chain/purchase-orders');
  }

  // The lines change on the order page, with the header — Modify.
  const addLineButton = po.canEdit ? (
    <Link className="btn btn-sm" to={`/g-chain/purchase-orders/${po.id}/edit`}>
      Add lines
    </Link>
  ) : null;

  return (
    <div>
      <RecordHeader
        type="Purchase Order"
        code={po.number}
        title={po.supplier.name}
        status={po.status}
        amount={formatMoney(po.total)}
        amountLabel="Order total"
        meta={
          <>
            <Link to={`/g-chain/suppliers/${po.supplier.id}`}>{po.supplier.name}</Link> ·{' '}
            {po.job ? (
              <Link to={`/g-ops/projects/${po.job.id}`}>
                {po.job.number} — {po.job.name}
              </Link>
            ) : (
              `Stock replenishment${po.warehouse ? ` for ${po.warehouse.name}` : ''}`
            )}
            {po.request && (
              <>
                {' '}
                · from <Link to={`/g-chain/purchase-requests/${po.request.id}`}>{po.request.number}</Link>
              </>
            )}{' '}
            · ordered {formatDate(po.orderDate)}
            {po.deliveryDate ? ` · required by ${formatDate(po.deliveryDate)}` : ''}
            {po.fromCanvass && (
              <>
                {' '}
                · awarded on <Link to={`/g-chain/canvass/${po.fromCanvass.id}`}>{po.fromCanvass.number}</Link>
              </>
            )}
          </>
        }
        actions={
          <>
            {isDraft && can('gchain.purchase_orders.create') && po.items.length > 0 && (
              <button className="btn btn-primary" onClick={submit}>
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
        print={`/api/purchase-orders/${po.id}/pdf`}
        more={[
          mayDelete && {
            label: 'Delete',
            danger: true,
            confirm: {
              title: `Delete ${po.number}?`,
              body: 'It cannot be undone.',
              confirmLabel: 'Delete',
              onConfirm: remove,
            },
          },
        ]}
        modify={po.canEdit ? `/g-chain/purchase-orders/${po.id}/edit` : undefined}
      />

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
                <th>Budget line</th>
                <th>Part No.</th>
                <th>Item</th>
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
                  <td>{i.costCategory?.name ?? <span className="faint">—</span>}</td>
                  <td className="mono">{i.partNumber ?? (i.item ? i.item.code : '')}</td>
                  <td>
                    {i.name && i.name !== i.description ? (
                      <>
                        <strong>{i.name}</strong>
                        <div className="faint">{i.description}</div>
                      </>
                    ) : (
                      <strong>{i.name ?? i.description}</strong>
                    )}
                  </td>
                  <td className="right mono">{i.quantity}</td>
                  <td>{i.unit}</td>
                  <td className="right mono">{formatMoney(i.unitPrice)}</td>
                  <td className="right mono">{formatMoney(i.amount)}</td>
                  <td className="right mono">{i.receivedQty || <span className="faint">—</span>}</td>
                  <td className={`right mono${i.outstandingQty > 0 && !isDraft ? ' proc-short' : ''}`}>
                    {i.outstandingQty || '—'}
                  </td>
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
                  <Link key={r.id} to={`/g-chain/incoming/${r.id}`} className="proc-link-row">
                    <span className="mono">{r.number}</span>
                    <span>{formatDate(r.receivedDate)}</span>
                    <span className="faint">{r.receivedBy.name}</span>
                    {r.status !== 'RECEIVED' && <StatusBadge status={r.status} />}
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

      {receiving && (
        <ReceiveModal
          po={po}
          onClose={() => setReceiving(false)}
          onReceived={(receivingId) => navigate(`/g-chain/incoming/${receivingId}`)}
        />
      )}
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
      const created = await api.post<{ id: string; needsApproval?: boolean }>('/receivings', {
        orderId: po.id,
        warehouseId: warehouseId || null,
        deliveryRefNo: deliveryRefNo || null,
        items: po.items
          .filter((i) => Number(quantities[i.id]) > 0)
          .map((i) => ({ orderItemId: i.id, quantity: Number(quantities[i.id]) })),
      });
      // With the Incoming route active the report is a draft: its page takes
      // the packing list, then goes for approval — nothing moves until then.
      toast('ok', created.needsApproval ? 'Saved — attach the packing list, then submit it for approval' : 'Goods received');
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
      title={`Receive goods against ${po.number}`}
      onClose={onClose}
      footer={
        <ModalFoot onCancel={onClose} busy={busy}>
          <button className="btn btn-primary" onClick={receive} disabled={busy || receivingValue <= 0}>
            {busy ? 'Receiving…' : 'Receive goods'}
          </button>
        </ModalFoot>
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
