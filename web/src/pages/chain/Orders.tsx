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
  StatusBadge,
  formatDate,
  formatMoney,
  useToast,
} from '../../components/ui';
import { Stat } from '../../components/charts';
import { DocumentApproval, DecisionNote } from '../../components/ApprovalStepper';
import { RecordHeader } from '../../components/RecordHeader';
import { ProgressBar } from '../delivery/Projects';
import { NumberInput } from '../../components/NumberInput';
import { PO_CURRENCIES } from './PurchaseOrderEditor';

// ════════════════════════════════════════════════════════════════════
//  PURCHASE ORDERS
// ════════════════════════════════════════════════════════════════════

interface PoRow {
  currency?: string;
  id: string;
  number: string;
  kind: string;
  status: string;
  orderDate: string;
  deliveryDate: string | null;
  total: number;
  /** What its goods come to in pesos — landed, declared or converted; null while a line has no rate. */
  landedTotal?: number | null;
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
      render: (o) => <span className="mono">{formatMoney(o.total, o.currency ?? 'PHP')}</span>,
    },
    {
      // In the order's own currency above; what the goods come to in pesos here (2026-10-23).
      key: 'landed',
      label: 'Landed (PHP)',
      align: 'right',
      render: (o) =>
        o.landedTotal == null ? <span className="faint">no rate</span> : <span className="mono">{formatMoney(o.landedTotal)}</span>,
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
        reportPath="/g-chain/reports?kind=purchase-orders"
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
  currency?: string;
  id: string;
  number: string;
  kind: string;
  status: string;
  orderDate: string;
  deliveryDate: string | null;
  quoteRef: string | null;
  deliverTo: string | null;
  terms: string | null;
  notes: string | null;
  vatRate: number;
  vatInclusive: boolean;
  subtotal: number;
  /** The order's discount (2026-10-23): a percentage, and what it takes off the subtotal. */
  discountPct?: number;
  discountAmount?: number;
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
  canWithdraw?: boolean;
  canCancel?: boolean;
  canDelete?: boolean;
  cancelReason?: string | null;
  /** Placed from this awarded canvass: the supplier is decided. */
  fromCanvass: { id: string; number: string } | null;
  /** The approver's reason, when the latest submission was rejected back to draft. */
  returned: { by: string | null; comment: string | null; at: string | null } | null;
  exchangeRate?: number | null;
  /** What the goods come to in pesos; null while a line has no peso cost. */
  landedTotal?: number | null;
  /** The buyer (or Edit All) sets the landed cost and corrects the currency. */
  canSetLanded?: boolean;
}

/** Where a line's peso cost comes from (shared/receiptCost.ts). */
const BASIS_WORDS: Record<string, string> = {
  landed: 'landed cost',
  request: "request's declared",
  order: "order's price",
  converted: 'at the rate',
  no_rate: 'no rate to PHP',
};

interface PoLine {
  id: string;
  nature?: 'GOODS' | 'SERVICE';
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
  landedUnitCost?: number | null;
  pesoUnitCost?: number | null;
  pesoBasis?: string;
}

export function PurchaseOrderDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { can } = useAuth();
  const toast = useToast();

  const [po, setPo] = useState<PoDetailData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  // Bumped on every load so the approval chain re-reads after a submit.
  const [reload, setReload] = useState(0);
  const [landedOpen, setLandedOpen] = useState(false);

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
  // The API's own rule: a draft or a cancelled order, nothing received against it.
  const mayDelete = !!po.canDelete;

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
        amount={formatMoney(po.total, po.currency ?? 'PHP')}
        amountLabel="Order total"
        meta={
          <>
            <Link to={`/g-chain/suppliers/${po.supplier.id}`}>{po.supplier.name}</Link> ·{' '}
            {po.job ? (
              <Link to={`/g-ops/projects/${po.job.id}`}>
                {po.job.number} — {po.job.name}
              </Link>
            ) : (
              po.kind === 'DIRECT_TO_JOB'
                ? 'Direct to project — no project named'
                : `Stock replenishment${po.warehouse ? ` for ${po.warehouse.name}` : ''}`
            )}
            {po.request && (
              <>
                {' '}
                · from <Link to={`/g-chain/purchase-requests/${po.request.id}`}>{po.request.number}</Link>
              </>
            )}{' '}
            · ordered {formatDate(po.orderDate)}
            {po.deliveryDate ? ` · required by ${formatDate(po.deliveryDate)}` : ''}
            {po.quoteRef ? ` · quotation ${po.quoteRef}` : ''}
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
                <Link className="btn btn-primary" to={`/g-chain/incoming/new?order=${po.id}`}>
                  Receive goods
                </Link>
              )}
          </>
        }
        print={`/api/purchase-orders/${po.id}/pdf`}
        more={[
          po.canWithdraw && {
            label: 'Pull back to draft',
            confirm: {
              title: `Pull ${po.number} back to draft?`,
              body: 'The approval request is withdrawn and the approvers are told. It comes back as the same draft to modify and submit again.',
              confirmLabel: 'Pull it back',
              onConfirm: async () => {
                await api.post(`/purchase-orders/${po.id}/withdraw`);
                toast('ok', 'Back to draft');
                await load();
              },
            },
          },
          po.canCancel && {
            label: 'Cancel order',
            danger: true,
            confirm: {
              title: `Cancel ${po.number}?`,
              body:
                po.status === 'PENDING_APPROVAL'
                  ? 'The approval request is withdrawn and the approvers are told. A cancelled order can then be deleted.'
                  : 'It is kept as cancelled, with the reason. A cancelled order can then be deleted.',
              confirmLabel: 'Cancel order',
              reason: 'required',
              minReason: 3,
              onConfirm: async (reason: string) => {
                await api.post(`/purchase-orders/${po.id}/cancel`, { reason });
                toast('ok', `${po.number} cancelled`);
                await load();
              },
            },
          },
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

      <DecisionNote documentType="purchase_order" documentId={po.id} reloadToken={reload} />
      <DocumentApproval documentType="purchase_order" documentId={po.id} reloadToken={reload} />

      <ErrorBox error={error} />

      {po.status === 'CANCELLED' && (
        <div className="alert info" role="status">
          <strong>Cancelled</strong>
          {po.cancelReason ? `: ${po.cancelReason}` : '.'}
        </div>
      )}
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
          one to the price actually agreed with {po.supplier.name} before submitting. Budget Monitoring
          keeps counting the request's declared value; the order's prices move no budget line.
        </div>
      )}
      {po.status === 'PENDING_APPROVAL' && (
        <div className="alert info">With the approvers. It cannot be changed until they decide.</div>
      )}

      {po.status === 'ISSUED' && po.kind === 'SALES_ORDER' && (
        <div className="alert ok">
          Issued for a sales order — {formatMoney(po.subtotal - (po.discountAmount ?? 0), po.currency ?? 'PHP')} is committed against the order's quoted cost. No project is charged.
        </div>
      )}
      {po.status === 'ISSUED' && po.kind === 'DIRECT_TO_JOB' && (
        <div className="alert ok">
          Issued — {formatMoney(po.subtotal - (po.discountAmount ?? 0))} is committed against the project at the agreed price.
          The request's estimate has been released, so it is not counted twice.
        </div>
      )}

      <div className="kpi-grid proc-stats">
        <Stat
          label="Subtotal"
          value={formatMoney(po.subtotal, po.currency ?? 'PHP')}
          sub={
            po.discountAmount
              ? `less ${Number(po.discountPct ?? 0).toLocaleString('en-PH', { maximumFractionDigits: 6 })}% discount: −${formatMoney(po.discountAmount, po.currency ?? 'PHP')}`
              : undefined
          }
          figure
        />
        <Stat
          label={po.vatRate > 0 ? `VAT ${(po.vatRate * 100).toFixed(0)}%` : 'VAT'}
          value={formatMoney(po.vatAmount, po.currency ?? 'PHP')}
          sub={po.vatRate > 0 ? (po.vatInclusive ? 'included in the prices' : 'added to the prices') : 'not applied (importation)'}
          figure
        />
        <Stat label="Total" value={formatMoney(po.total, po.currency ?? 'PHP')} accent="neon" figure />
        <Stat
          label="Landed (PHP)"
          value={po.landedTotal == null ? '—' : formatMoney(po.landedTotal)}
          sub={po.landedTotal == null ? `no rate to PHP for ${po.currency}` : 'what the goods are stocked at'}
          figure
        />
        <Stat
          label="Outstanding"
          value={`${outstanding} units`}
          sub={outstanding > 0 && !isDraft ? 'still to be delivered' : undefined}
          figure
        />
      </div>

      <div className="card proc-card">
        <div className="card-head">
          <h3 className="card-title">Order lines</h3>
          {po.canSetLanded && po.items.length > 0 && !landedOpen && (
            <div className="card-actions">
              <button className="btn btn-sm" onClick={() => setLandedOpen(true)}>
                Set landed cost (PHP)
              </button>
            </div>
          )}
        </div>
        {landedOpen && (
          <LandedPanel
            po={po}
            onClose={() => setLandedOpen(false)}
            onSaved={async (restated) => {
              setLandedOpen(false);
              toast('ok', restated ? `Landed cost saved — ${restated} received line${restated === 1 ? '' : 's'} restated in pesos` : 'Landed cost saved');
              await load();
            }}
          />
        )}
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
                <th className="right">Landed unit (PHP)</th>
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
                      {i.nature === 'SERVICE' && <div className="faint">Service</div>}
                  </td>
                  <td className="right mono">{i.quantity}</td>
                  <td>{i.unit}</td>
                  <td className="right mono">{formatMoney(i.unitPrice, po.currency ?? 'PHP')}</td>
                  <td className="right mono">{formatMoney(i.amount, po.currency ?? 'PHP')}</td>
                  <td className="right">
                    <span className="mono">{i.pesoUnitCost == null ? '—' : formatMoney(i.pesoUnitCost)}</span>
                    {i.pesoBasis && <div className="faint">{BASIS_WORDS[i.pesoBasis] ?? i.pesoBasis}</div>}
                  </td>
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

    </div>
  );
}


/**
 * The landed cost in pesos (2026-10-23): per line, by the unit or the line's
 * total, and the order's currency and rate put right — on any order not
 * cancelled. Goods already received at the old figure are restated by the
 * server. A panel in the card, never a dialog.
 */
function LandedPanel({ po, onClose, onSaved }: { po: PoDetailData; onClose: () => void; onSaved: (restated: number) => void | Promise<void> }) {
  const [currency, setCurrency] = useState(po.currency ?? 'PHP');
  const [rate, setRate] = useState(po.exchangeRate != null ? String(po.exchangeRate) : '');
  const [units, setUnits] = useState<Record<string, string>>(() =>
    Object.fromEntries(po.items.map((i) => [i.id, i.landedUnitCost != null ? String(i.landedUnitCost) : ''])),
  );
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const issued = !['DRAFT', 'PENDING_APPROVAL'].includes(po.status);
  const currencyChanged = currency !== (po.currency ?? 'PHP');
  const lineTotal = (id: string, qty: number) => (units[id] === '' ? '' : String(Math.round(Number(units[id]) * qty * 100) / 100));
  const sum = po.items.reduce((s, i) => s + (units[i.id] === '' ? 0 : Math.round(Number(units[i.id]) * i.quantity * 100)), 0) / 100;

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const res = await api.put<{ restated: number }>(`/purchase-orders/${po.id}/landed`, {
        ...(currencyChanged ? { currency } : {}),
        ...(currency !== 'PHP' && Number(rate) > 0 && Number(rate) !== po.exchangeRate ? { exchangeRate: Number(rate) } : {}),
        lines: po.items.map((i) => ({ id: i.id, landedUnitCost: units[i.id] === '' || Number(units[i.id]) === 0 ? null : Number(units[i.id]) })),
        reason: reason.trim() || null,
      });
      await onSaved(res.restated);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="prq-panel">
      <p className="faint">
        What each unit really costs in pesos, freight, duties and charges in. The Incoming report, the inventory and a
        sales order's spend take it; a project's budget keeps the request's declared value. Goods already received are
        restated. Blank keeps the order's own figure ({currency === 'PHP' ? 'its price' : `its price at the rate to PHP`}, or the request's declared cost).
      </p>
      <div className="grid grid-2">
        <Field label="Currency" hint="What the supplier's prices are in — correct it if it was saved wrong">
          <select value={currency} onChange={(e) => { setCurrency(e.target.value); setRate(''); }}>
            {PO_CURRENCIES.map((c) => (
              <option key={c} value={c}>{c}</option>
            ))}
          </select>
        </Field>
        {currency !== 'PHP' && (
          <Field label="Rate to PHP" hint={`Pesos per ${currency}; blank takes Company Settings' rate`}>
            <NumberInput kind="decimal" value={rate} min={0} onChange={(e) => setRate(e.target.value)} />
          </Field>
        )}
      </div>
      <div className="table-wrap">
        <table className="data">
          <thead>
            <tr>
              <th>Item</th>
              <th className="right">Qty</th>
              <th className="right">Unit price ({po.currency ?? 'PHP'})</th>
              <th className="right">Landed unit (PHP)</th>
              <th className="right">Landed line total (PHP)</th>
            </tr>
          </thead>
          <tbody>
            {po.items.map((i) => (
              <tr key={i.id}>
                <td>{i.name ?? i.description}</td>
                <td className="right mono">{i.quantity}</td>
                <td className="right mono">{formatMoney(i.unitPrice, po.currency ?? 'PHP')}</td>
                <td className="right">
                  <NumberInput
                    kind="money"
                    value={units[i.id]}
                    min={0}
                    aria-label={`Landed unit cost of ${i.name ?? i.description}`}
                    onChange={(e) => setUnits((u) => ({ ...u, [i.id]: e.target.value }))}
                  />
                </td>
                <td className="right">
                  <NumberInput
                    kind="money"
                    value={lineTotal(i.id, i.quantity)}
                    min={0}
                    aria-label={`Landed total of ${i.name ?? i.description}`}
                    onChange={(e) =>
                      setUnits((u) => ({
                        ...u,
                        [i.id]: e.target.value === '' ? '' : String(Math.round((Number(e.target.value) / i.quantity) * 100) / 100),
                      }))
                    }
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="right">
        Landed total typed: <strong className="mono">{formatMoney(sum)}</strong>
      </p>
      {(issued || currencyChanged) && (
        <Field label="Why" hint={currencyChanged && issued ? 'Required: the currency changes after the order was issued' : 'Kept on the order’s trail'}>
          <input value={reason} maxLength={2000} onChange={(e) => setReason(e.target.value)} />
        </Field>
      )}
      <ErrorBox error={error} />
      <div className="row prq-panel-foot">
        <span className="spacer" />
        <button className="btn btn-sm" onClick={onClose} disabled={busy}>
          Cancel
        </button>
        <button className="btn btn-primary btn-sm" onClick={save} disabled={busy || (currencyChanged && issued && reason.trim().length < 3)}>
          {busy ? 'Saving…' : 'Save'}
        </button>
      </div>
    </div>
  );
}
