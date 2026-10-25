import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api, qs } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { DataList, type Column } from '../../components/DataList';
import {
  Empty,
  ErrorBox,
  Field,
  Loading,
  Modal,
  ModalFoot,
  ProductPicture,
  StatusBadge,
  formatDate,
  formatDateTime,
  formatMoney,
  useToast,
} from '../../components/ui';
import { BarList, Panel, Stat } from '../../components/charts';
import { ImportModal, loadImportSpec } from '../../components/ImportModal';
import { RecordHeader } from '../../components/RecordHeader';
import { useConfirm } from '../../components/Confirm';
import { ApprovalStepper, DocumentApproval, DecisionNote, allHeld, previewSteps, type PreviewRoute } from '../../components/ApprovalStepper';
import { Attachments } from '../../components/Attachments';
import { NumberInput } from '../../components/NumberInput';
import { PhotoCard } from '../../components/PhotoCard';
import { label } from './PurchaseRequests';

// ════════════════════════════════════════════════════════════════════
//  RECEIVING
// ════════════════════════════════════════════════════════════════════

interface ReceivingRow {
  id: string;
  number: string;
  status: string;
  receivedDate: string;
  deliveryRefNo: string | null;
  lineCount: number;
  value: number;
  order: {
    id: string;
    number: string;
    kind: string;
    supplier: { id: string; name: string };
    job: { id: string; number: string; name: string } | null;
  } | null;
  /** Where it came from: the order's supplier, else the supplier or name on the report. */
  from: string;
  warehouse: { id: string; name: string } | null;
  receivedBy: { id: string; name: string };
}

/** A received report is the record; one still waiting reads as such. */
const RECEIVING_TONES = { RECEIVED: 'ok', PENDING_APPROVAL: 'warn' } as const;

export function Receivings() {
  const navigate = useNavigate();
  const { can } = useAuth();

  const columns: Column<ReceivingRow>[] = [
    { key: 'number', label: 'Number', sortKey: 'number', width: '160px', render: (r) => <span className="mono">{r.number}</span> },
    {
      key: 'order',
      label: 'From',
      render: (r) => (
        <div>
          <div>{r.from}</div>
          {r.order ? <div className="faint mono">{r.order.number}</div> : <div className="faint">No purchase order</div>}
        </div>
      ),
    },
    { key: 'for', label: 'For', render: (r) => (r.order?.job ? `${r.order.job.number}` : <span className="faint">Stock</span>) },
    { key: 'warehouse', label: 'Into', render: (r) => r.warehouse?.name ?? <span className="faint">site</span> },
    { key: 'receivedDate', label: 'Received', sortKey: 'receivedDate', render: (r) => formatDate(r.receivedDate) },
    { key: 'lines', label: 'Lines', align: 'right', render: (r) => r.lineCount },
    { key: 'value', label: 'Value', align: 'right', render: (r) => <span className="mono">{formatMoney(r.value)}</span> },
    { key: 'receivedBy', label: 'By', render: (r) => r.receivedBy.name },
    { key: 'ref', label: 'DR no.', render: (r) => r.deliveryRefNo ?? '—', optional: true },
    { key: 'status', label: 'Status', render: (r) => <StatusBadge status={r.status} extra={RECEIVING_TONES} /> },
  ];

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Incoming Reports</h1>
        </div>
      </div>

      <DataList<ReceivingRow>
        listKey="receivings"
        endpoint="/receivings"
        printPath="/api/receivings/pdf"
        reportPath="/g-chain/reports?kind=incoming"
        columns={columns}
        rowKey={(r) => r.id}
        searchPlaceholder="Search number, order, supplier…"
        onRowClick={(r) => navigate(`/g-chain/incoming/${r.id}`)}
        emptyTitle="Nothing received yet"
        emptyHint="Receive against an issued purchase order, or without one."
        actions={
          can('gchain.receiving.create') ? (
            <Link className="btn btn-primary btn-sm" to="/g-chain/incoming/new">
              + New incoming
            </Link>
          ) : undefined
        }
        summary={(raw, total) => {
          const sum = raw as { receivedValue?: number; waiting?: number; drafts?: number; withoutOrder?: number };
          return (
            <>
              <Stat label="Incoming reports" value={total} />
              <Stat label="Value received" value={formatMoney(sum.receivedValue ?? 0)} />
              <Stat label="Waiting for approval" value={sum.waiting ?? 0} to="/g-chain/incoming?status=PENDING_APPROVAL" />
              <Stat label="Drafts" value={sum.drafts ?? 0} accent="quiet" to="/g-chain/incoming?status=DRAFT" />
              <Stat label="Without a purchase order" value={sum.withoutOrder ?? 0} accent="quiet" to="/g-chain/incoming?against=none" />
            </>
          );
        }}
        filters={[
          {
            key: 'against',
            label: 'Received against',
            options: [
              { value: 'order', label: 'A purchase order' },
              { value: 'none', label: 'No purchase order' },
            ],
          },
          {
            key: 'status',
            label: 'Status',
            options: [
              { value: 'DRAFT', label: 'Draft' },
              { value: 'PENDING_APPROVAL', label: 'Pending approval' },
              { value: 'RECEIVED', label: 'Received' },
              { value: 'CANCELLED', label: 'Cancelled' },
            ],
          },
        ]}
      />
    </div>
  );
}

/**
 * Puts right the peso unit cost of goods already received (2026-10-23): the
 * stock movement, the shelf's average and the item's last cost follow. A
 * line left blank goes back to what the order says. In the card, never a
 * dialog.
 */
function CorrectCostPanel({
  receivingId,
  items,
  hasOrder,
  onClose,
  onSaved,
}: {
  receivingId: string;
  items: { id: string; name: string | null; description: string; quantity: number; unit: string; unitCost: number; costTyped?: boolean }[];
  hasOrder: boolean;
  onClose: () => void;
  onSaved: (changed: number) => void | Promise<void>;
}) {
  const [costs, setCosts] = useState<Record<string, string>>(() => Object.fromEntries(items.map((i) => [i.id, String(i.unitCost)])));
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const changed = items.filter((i) => (costs[i.id] === '' ? hasOrder && i.costTyped : Math.abs(Number(costs[i.id]) - i.unitCost) >= 0.005));

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const res = await api.post<{ changed: number }>(`/receivings/${receivingId}/costs`, {
        reason: reason.trim(),
        lines: changed.map((i) => ({ id: i.id, unitCost: costs[i.id] === '' ? null : Number(costs[i.id]) })),
      });
      await onSaved(res.changed);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="prq-panel">
      <p className="faint">
        The landed cost of one unit in pesos. The stock, its average cost and the item's last cost follow; what already
        left the shelf keeps the cost it left at.{hasOrder ? ' Blank goes back to what the order says.' : ''}
      </p>
      <div className="table-wrap">
        <table className="data">
          <thead>
            <tr>
              <th>Item</th>
              <th className="right">Qty</th>
              <th className="right">Now (PHP)</th>
              <th className="right">Unit cost (PHP)</th>
              <th className="right">Amount (PHP)</th>
            </tr>
          </thead>
          <tbody>
            {items.map((i) => (
              <tr key={i.id}>
                <td>{i.name ?? i.description}</td>
                <td className="right mono">
                  {i.quantity} {i.unit}
                </td>
                <td className="right mono">{formatMoney(i.unitCost)}</td>
                <td className="right">
                  <NumberInput
                    kind="money"
                    min={0}
                    value={costs[i.id]}
                    aria-label={`Unit cost in pesos — ${i.name ?? i.description}`}
                    onChange={(e) => setCosts((c) => ({ ...c, [i.id]: e.target.value }))}
                  />
                </td>
                <td className="right mono">{costs[i.id] === '' ? '—' : formatMoney(Math.round(Number(costs[i.id]) * i.quantity * 100) / 100)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <Field label="Why" hint="Kept on the report's trail">
        <input value={reason} maxLength={2000} onChange={(e) => setReason(e.target.value)} />
      </Field>
      <ErrorBox error={error} />
      <div className="row prq-panel-foot">
        <span className="spacer" />
        <button className="btn btn-sm" onClick={onClose} disabled={busy}>
          Cancel
        </button>
        <button className="btn btn-primary btn-sm" onClick={save} disabled={busy || !changed.length || reason.trim().length < 3}>
          {busy ? 'Saving…' : `Save${changed.length ? ` (${changed.length})` : ''}`}
        </button>
      </div>
    </div>
  );
}

export function ReceivingDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { can } = useAuth();
  const toast = useToast();
  const confirm = useConfirm();
  const [rec, setRec] = useState<Record<string, unknown> | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [modifying, setModifying] = useState(false);
  const [correcting, setCorrecting] = useState(false);
  const [reload, setReload] = useState(0);

  const load = useCallback(async () => {
    if (!id) return;
    try {
      setRec(await api.get<Record<string, unknown>>(`/receivings/${id}`));
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
  if (!rec) return <ErrorBox error={error ?? new Error('Not found')} />;

  const order = rec.order as {
    id: string;
    number: string;
    kind: string;
    supplier: { id: string; name: string };
    job: { id: string; number: string; name: string } | null;
    salesOrder?: { id: string; number: string } | null;
  } | null;
  const from = String(rec.from ?? '');
  const fromSupplier = (rec.supplier ?? null) as { id: string; name: string } | null;
  // Empty unless the caller holds gfin.ap.view_all (billsVisible says which).
  const bills = (rec.bills ?? []) as { id: string; number: string; status: string }[];
  const billsVisible = rec.billsVisible === true;
  // One bill per delivery is the norm; offer to enter it until one exists.
  // Someone who cannot see bills can still enter one — the AP screen decides.
  const canEnterBill = can('gfin.ap.create') && (!billsVisible || bills.length === 0);
  const items = rec.items as {
    id: string;
    code: string | null;
    name: string | null;
    description: string;
    unit: string;
    quantity: number;
    unitCost: number;
    /** The peso cost was typed on the report, over what the order says. */
    costTyped?: boolean;
    amount: number;
    serialNo: string | null;
    batchNo: string | null;
    /** A service received as "service rendered" — no stock (2026-10-21). */
    service?: boolean;
    orderItem: { costCategory: { name: string } | null } | null;
  }[];

  const status = String(rec.status ?? 'RECEIVED');
  const received = status === 'RECEIVED';
  const route = (rec.approvalRoute ?? null) as PreviewRoute | null;
  const recId = String(rec.id);
  /** Asked in the confirm bar, which shows a refusal — so these throw rather than catching. */
  async function submit() {
    setRec(await api.post<Record<string, unknown>>(`/receivings/${recId}/submit`));
    setReload((n) => n + 1);
    toast('ok', `${String(rec?.number)} submitted for approval`);
  }
  async function withdraw() {
    setRec(await api.post<Record<string, unknown>>(`/receivings/${recId}/withdraw`));
    setReload((n) => n + 1);
    toast('ok', `${String(rec?.number)} pulled back to a draft`);
  }
  async function cancel(reason: string) {
    await api.post(`/receivings/${recId}/cancel`, { reason });
    toast('ok', `${String(rec?.number)} cancelled`);
    await load();
  }
  async function remove() {
    await api.del(`/receivings/${recId}`);
    toast('ok', `${String(rec?.number)} deleted`);
    navigate('/g-chain/incoming');
  }

  const warehouse = rec.warehouse as { name: string } | null;
  const refs = {
    number: String(rec.number),
    deliveryRefNo: typeof rec.deliveryRefNo === 'string' ? rec.deliveryRefNo : null,
    invoiceRefNo: typeof rec.invoiceRefNo === 'string' ? rec.invoiceRefNo : null,
    notes: typeof rec.notes === 'string' ? rec.notes : null,
  };

  return (
    <div>
      <RecordHeader
        type="Incoming"
        code={String(rec.number)}
        title={from}
        status={status}
        statusExtra={RECEIVING_TONES}
        amount={formatMoney(Number(rec.value))}
        amountLabel={received ? 'Value received' : 'Value'}
        meta={
          <>
            {order ? (
              <>
                Against <Link to={`/g-chain/purchase-orders/${order.id}`}>{order.number}</Link> ·{' '}
                {order.job ? (
                  <Link to={`/g-ops/projects/${order.job.id}`}>
                    {order.job.number} — {order.job.name}
                  </Link>
                ) : (
                  'Stock'
                )}{' '}
                · from <Link to={`/g-chain/suppliers/${order.supplier.id}`}>{order.supplier.name}</Link>
              </>
            ) : (
              <>
                No purchase order · from{' '}
                {fromSupplier ? <Link to={`/g-chain/suppliers/${fromSupplier.id}`}>{fromSupplier.name}</Link> : from}
              </>
            )}{' '}
            · received{' '}
            {formatDate(String(rec.receivedDate))}
            {warehouse ? ` into ${warehouse.name}` : ''}
            {refs.deliveryRefNo ? ` · DR ${refs.deliveryRefNo}` : ''}
            {refs.invoiceRefNo ? ` · invoice ${refs.invoiceRefNo}` : ''}
            {bills.length > 0 && (
              <>
                {' '}
                · billed as{' '}
                {bills.map((b, n) => (
                  <span key={b.id}>
                    {n > 0 && ', '}
                    <Link to={`/g-fin/ap/${b.id}`} className="mono">
                      {b.number}
                    </Link>{' '}
                    <StatusBadge status={b.status} />
                  </span>
                ))}
              </>
            )}
          </>
        }
        actions={
          rec.canSubmit === true ? (
            <button
              className="btn btn-primary"
              onClick={() =>
                confirm.ask({
                  title: rec.needsApproval === false ? `Receive ${String(rec.number)} now?` : `Submit ${String(rec.number)} for approval?`,
                  body:
                    rec.needsApproval === false
                      ? 'No approval route applies: the goods go into stock or onto the project now, and the order shows them received.'
                      : 'Nothing moves until it is approved: then the goods go into stock or onto the project, and the order shows them received. Attach the packing list or delivery receipt first.',
                  confirmLabel: rec.needsApproval === false ? 'Receive now' : 'Submit for approval',
                  tone: 'primary',
                  onConfirm: submit,
                })
              }
            >
              {rec.needsApproval === false ? 'Receive now' : 'Submit for approval'}
            </button>
          ) : (
            received &&
            order &&
            canEnterBill && (
              // The bill picks up the supplier, order and these goods from the
              // receiving, and — because it names the receiving — posts no job
              // cost a second time.
              <Link to={`/g-fin/ap?fromReceiving=${recId}`} className="btn btn-primary">
                Enter supplier bill
              </Link>
            )
          )
        }
        print={`/api/receivings/${recId}/pdf`}
        more={[
          rec.canWithdraw === true && {
            label: 'Pull back to a draft',
            hint: 'Withdraws it from the approver',
            confirm: {
              title: `Pull ${String(rec.number)} back to a draft?`,
              body: 'Its approval is withdrawn and the approver is told. Submit it again when it is right.',
              confirmLabel: 'Pull back',
              tone: 'primary',
              onConfirm: withdraw,
            },
          },
          rec.canCancel === true && {
            label: 'Cancel receiving',
            danger: true,
            confirm: {
              title: `Cancel ${String(rec.number)}?`,
              body: 'Nothing was received on it, and nothing moves. The goods can be received again on a new report.',
              confirmLabel: 'Cancel receiving',
              reason: 'required',
              minReason: 3,
              reasonLabel: 'Why is it cancelled?',
              onConfirm: cancel,
            },
          },
          rec.canDelete === true && {
            label: 'Delete',
            danger: true,
            confirm: {
              title: `Delete ${String(rec.number)}?`,
              body: `This ${status === 'DRAFT' ? 'draft' : 'cancelled'} incoming report goes for good, with its files. Nothing was received on it. Its number is not reused.`,
              confirmLabel: 'Delete',
              onConfirm: remove,
            },
          },
        ]}
        // A draft is modified whole on its page; past a draft, its references only.
        modify={rec.canModify === true ? `/g-chain/incoming/${recId}/edit` : rec.canEdit === true ? () => setModifying(true) : undefined}
        confirm={confirm}
      />

      {status === 'DRAFT' && route && route.steps.length > 0 && (
        <div className="qd-route">
          <span className="qd-route-label">{allHeld(route) ? 'No one else’s approval needed' : 'Submit for approval sends it to'}</span>
          <ApprovalStepper steps={previewSteps(route)} />
        </div>
      )}
      <DecisionNote documentType="receiving" documentId={recId} reloadToken={reload} />
      {(status === 'PENDING_APPROVAL' || received) && <DocumentApproval documentType="receiving" documentId={recId} reloadToken={reload} />}

      <ErrorBox error={error} />

      {received ? (
        <div className={`alert ${order?.kind === 'DIRECT_TO_JOB' || order?.kind === 'SALES_ORDER' ? 'ok' : 'info'}`}>
          {order?.kind === 'SALES_ORDER'
            ? `${formatMoney(Number(rec.value))} received for sales order ${order.salesOrder?.number ?? ''} — no project charged.${warehouse ? ` The goods are held in ${warehouse.name} for the order, released by a pull-out or Outgoing slip.` : ' Delivered straight to the customer.'}`
            : order?.kind === 'DIRECT_TO_JOB'
            ? `${formatMoney(Number(rec.value))} charged to ${order.job?.number ?? 'the project'}, and the same released from committed.${warehouse ? ` The goods are in ${warehouse.name} as the project's own stock.` : ''}`
            : `${formatMoney(Number(rec.value))} added to stock. No project has been charged — that happens at issuance.`}
        </div>
      ) : status === 'CANCELLED' ? (
        <div className="alert info">Cancelled{typeof rec.cancelReason === 'string' ? ` — ${rec.cancelReason}` : ''}. Nothing was received on it.</div>
      ) : (
        <div className="alert info">
          {status === 'PENDING_APPROVAL'
            ? 'Waiting for approval. Nothing has moved yet.'
            : 'A draft — nothing has moved yet, and nothing will until it is submitted and approved. Attach the packing list or delivery receipt below, then submit it for approval.'}{' '}
          {/* Where the goods land once approved — the two purchase kinds stay disjoint (Phase 5). */}
          {order?.kind === 'SALES_ORDER'
            ? warehouse
              ? `Approved, the goods are held in ${warehouse.name} for sales order ${order.salesOrder?.number ?? ''} (Inventory › Stock: Sales order stock), released by a pull-out or Outgoing slip. No project is charged.`
              : `Approved, it counts as spent on sales order ${order.salesOrder?.number ?? ''}. Delivered straight to the customer, nothing enters a warehouse.`
            : order?.kind === 'DIRECT_TO_JOB'
            ? warehouse
              ? `Approved, it is charged to ${order.job?.number ?? 'the project'} and the goods sit in ${warehouse.name} as the project's own stock (Inventory › Stock: Project stock), released by Outgoing or a pull-out slip without being charged again.`
              : `Approved, it is charged to ${order.job?.number ?? 'the project'}. Delivered to site, nothing enters a warehouse — receive it into a warehouse to keep it as the project's stock.`
            : 'Approved, the goods are added to the warehouse’s stock and show on Inventory.'}
        </div>
      )}

      {typeof rec.reason === 'string' && (
        <div className="card proc-card">
          <h3 className="card-title">Why there is no purchase order</h3>
          <p className="activity-notes">{rec.reason}</p>
        </div>
      )}

      {refs.notes && (
        <div className="card proc-card">
          <h3 className="card-title">Notes</h3>
          <p className="activity-notes">{refs.notes}</p>
        </div>
      )}

      <div className="card">
        <div className="card-head">
          <h3 className="card-title">Items received</h3>
          {rec.canCorrectCost === true && !correcting && (
            <div className="card-actions">
              <button className="btn btn-sm" onClick={() => setCorrecting(true)}>
                Correct unit cost (PHP)
              </button>
            </div>
          )}
        </div>
        {correcting && (
          <CorrectCostPanel
            receivingId={recId}
            items={items}
            hasOrder={!!order}
            onClose={() => setCorrecting(false)}
            onSaved={async (changed) => {
              setCorrecting(false);
              toast('ok', changed ? `${changed} line${changed === 1 ? '' : 's'} restated — stock and averages follow` : 'Nothing changed');
              await load();
            }}
          />
        )}
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>Item</th>
                <th>Budget line</th>
                <th className="right">Qty</th>
                <th className="right">Unit cost (PHP)</th>
                <th className="right">Amount (PHP)</th>
                <th>Serial / batch</th>
              </tr>
            </thead>
            <tbody>
              {items.map((i) => (
                <tr key={i.id}>
                  <td>
                    <div>{i.name ?? i.description}</div>
                    {i.name && i.description && i.description !== i.name && <div className="faint">{i.description}</div>}
                    {i.code && <div className="faint mono">{i.code}</div>}
                    {i.service && <div className="faint">Service rendered — no stock</div>}
                  </td>
                  <td>{i.orderItem?.costCategory?.name ?? <span className="faint">—</span>}</td>
                  <td className="right mono">
                    {i.quantity} {i.unit}
                  </td>
                  <td className="right">
                    <span className="mono">{formatMoney(i.unitCost)}</span>
                    {i.costTyped && order && <div className="faint">typed over the order</div>}
                  </td>
                  <td className="right mono">{formatMoney(i.amount)}</td>
                  <td className="faint mono">{[i.serialNo, i.batchNo].filter(Boolean).join(' / ') || '—'}</td>
                </tr>
              ))}
              <tr>
                <td colSpan={4} className="right">
                  <strong>TOTAL</strong>
                </td>
                <td className="right mono">
                  <strong>{formatMoney(Number(rec.value))}</strong>
                </td>
                <td />
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <Attachments
        entityType="receiving"
        entityId={recId}
        title="Packing list and documents"
        hint="The delivery receipt, packing list, photos of what arrived — printed behind the report"
        canEdit={status === 'DRAFT' || status === 'PENDING_APPROVAL'}
      />

      {modifying && (
        <ReceivingRefsModal
          receivingId={String(rec.id)}
          refs={refs}
          onClose={() => setModifying(false)}
          onSaved={() => {
            setModifying(false);
            toast('ok', `${refs.number} updated`);
            void load();
          }}
        />
      )}
    </div>
  );
}

/**
 * Modify a receiving report: its paper references and notes only. The lines,
 * quantities, costs, warehouse and date moved stock and job cost, and stay as
 * they were received.
 */
function ReceivingRefsModal({
  receivingId,
  refs,
  onClose,
  onSaved,
}: {
  receivingId: string;
  refs: { number: string; deliveryRefNo: string | null; invoiceRefNo: string | null; notes: string | null };
  onClose: () => void;
  onSaved: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [form, setForm] = useState({
    deliveryRefNo: refs.deliveryRefNo ?? '',
    invoiceRefNo: refs.invoiceRefNo ?? '',
    notes: refs.notes ?? '',
  });

  async function save() {
    setBusy(true);
    setError(null);
    try {
      await api.patch(`/receivings/${receivingId}`, {
        deliveryRefNo: form.deliveryRefNo.trim() || null,
        invoiceRefNo: form.invoiceRefNo.trim() || null,
        notes: form.notes.trim() || null,
      });
      onSaved();
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  }

  return (
    <Modal
      title={`Modify receiving ${refs.number}`}
      onClose={onClose}
      footer={
        <ModalFoot onCancel={onClose} busy={busy}>
          <button className="btn btn-primary" onClick={save} disabled={busy}>
            {busy ? 'Saving…' : 'Save'}
          </button>
        </ModalFoot>
      }
    >
      <ErrorBox error={error} />
      <div className="alert info">
        What arrived — the lines, quantities, costs, warehouse and date — is the record and stays as
        received. Only the references and notes change here.
      </div>
      <div className="grid grid-2">
        <Field label="Delivery receipt no.">
          <input value={form.deliveryRefNo} onChange={(e) => setForm({ ...form, deliveryRefNo: e.target.value })} />
        </Field>
        <Field label="Supplier invoice no.">
          <input value={form.invoiceRefNo} onChange={(e) => setForm({ ...form, invoiceRefNo: e.target.value })} />
        </Field>
      </div>
      <Field label="Notes">
        <textarea rows={3} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
      </Field>
    </Modal>
  );
}

// Outgoing (the stock issue) lives in Outgoing.tsx: its list, page editor and record page.

// ════════════════════════════════════════════════════════════════════
//  INVENTORY
// ════════════════════════════════════════════════════════════════════

interface StockRow {
  id: string;
  quantity: number;
  borrowedQty: number;
  available: number;
  averageCost: number;
  value: number;
  needsReorder: boolean;
  /** In stock, low (reorder warning), critical (nothing, or under the minimum) or on order (an issued order still to arrive). */
  state: StockState;
  item: {
    id: string;
    code: string;
    partNumber: string | null;
    /** The manufacturer / OEM. */
    brand: string | null;
    name: string;
    description: string | null;
    unit: string;
    minStock: number | null;
    reorderLevel: number | null;
    /** The product's picture (2026-10-25). */
    photoId?: string | null;
    standardCost?: number | null;
    category: { id: string; name: string } | null;
    preferredSupplier: { id: string; name: string } | null;
  };
  /** The card's price: the average cost, else the standard cost while the shelf is empty. */
  unitPrice?: number;
  /** What issued purchase orders still have to bring in. */
  incoming?: number;
  /** Who has it on loan, on which slip. */
  loans?: { slipId: string; number: string; borrower: string; quantity: number }[];
  warehouse: { id: string; name: string };
  /** Its bin or rack. */
  location: { id: string; code: string; name: string | null } | null;
  /** A project's own stock (`?stock=project`, 2026-10-18): whose it is. */
  project?: { id: string; number: string; name: string };
  /** On the sales order list (`?stock=order`, 2026-10-21): whose goods they are. */
  salesOrder?: { id: string; number: string; customer: string };
}

type StockState = 'IN_STOCK' | 'LOW_STOCK' | 'CRITICAL' | 'OUT_OF_STOCK' | 'ON_ORDER' | 'PROJECT_STOCK';
const STOCK_STATE_LABEL: Record<Exclude<StockState, 'PROJECT_STOCK'>, string> = {
  IN_STOCK: 'In stock',
  LOW_STOCK: 'Low stock',
  CRITICAL: 'Critical',
  OUT_OF_STOCK: 'Out of stock',
  ON_ORDER: 'On order',
};
const stateLabel = (st: StockState) => (st === 'PROJECT_STOCK' ? 'Project stock' : STOCK_STATE_LABEL[st]);
const STOCK_STATE_TONES = { IN_STOCK: 'ok', LOW_STOCK: 'warn', CRITICAL: 'danger', OUT_OF_STOCK: 'danger', ON_ORDER: 'info', PROJECT_STOCK: 'info' } as const;

/** A category tile (2026-10-15, the owner's inventory screen): its items, their value, how many need reordering. */
interface CategoryTile {
  id: string;
  name: string;
  description: string | null;
  items: number;
  value: number;
  low: number;
  critical: number;
}

interface BrandTile {
  /** The filter's value: the brand as spelt, or `none`. */
  value: string;
  label: string;
  items: number;
  worth: number;
}

interface InventorySummary {
  items?: number;
  valuation?: number;
  lowStock?: number;
  critical?: number;
  outOfStock?: number;
  onOrder?: number;
  pendingOrders?: number;
  categories?: CategoryTile[];
  /** The valuation by brand (2026-10-25): every brand holding stock lines; `none` is Trading. */
  brands?: BrandTile[];
  /** On the company list: the projects' own goods on the shelves. */
  projectStock?: { lines: number; projects: number; value: number };
  /** On the project list (`?stock=project`) or the sales order list (`?stock=order`). */
  stock?: 'project' | 'order';
  projects?: number;
  orders?: number;
}

interface Movement {
  id: string;
  type: 'RECEIPT' | 'ISSUE' | 'BORROW' | 'RETURN' | 'ADJUSTMENT';
  quantity: number;
  sourceNumber: string | null;
  occurredAt: string;
  link: string | null;
  item: { id: string; code: string; name: string; unit: string };
  warehouse: { id: string; name: string };
  /** A move of a project's own stock. */
  job?: { id: string; number: string } | null;
}

/** "2h ago", "Yesterday", "Oct 9" — how long since a movement. */
function since(at: string) {
  const mins = Math.round((Date.now() - new Date(at).getTime()) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  if (mins < 24 * 60) return `${Math.round(mins / 60)}h ago`;
  if (mins < 48 * 60) return 'Yesterday';
  return formatDate(at);
}

/**
 * Under the stock (2026-10-14, the owner's inventory screen): the latest
 * movements in and out, each linking to its document. Receiving is the
 * list's "+ New incoming" and the stock report its Report button and ⋯ ›
 * Print (2026-10-18, rule 9) — the "Quick operations" card is gone.
 */
function InventoryFoot() {
  const [rows, setRows] = useState<Movement[] | null>(null);
  useEffect(() => {
    api.get<Movement[]>('/inventory/movements?limit=8').then(setRows).catch(() => setRows([]));
  }, []);
  return (
    <div className="inv-foot">
      <section className="card" aria-labelledby="inv-moves">
        <h2 id="inv-moves" className="card-title">Recent stock movement</h2>
        {!rows ? (
          <Loading />
        ) : !rows.length ? (
          <p className="collection-empty">Nothing has moved yet.</p>
        ) : (
          <ul className="inv-moves">
            {rows.map((m) => {
              const into = m.quantity > 0;
              const line = (
                <>
                  <span className={`inv-move-dir ${into ? 'is-in' : 'is-out'}`}>{into ? 'IN' : 'OUT'}</span>
                  <span className="inv-move-what">
                    {Math.abs(m.quantity)} {m.item.unit} {m.item.name} <span className="faint mono">({m.item.code})</span>
                  </span>
                  <span className="inv-move-where faint">
                    {m.sourceNumber ?? m.type.toLowerCase()} · {m.warehouse.name}
                    {m.job ? ` · ${m.job.number}'s stock` : ''} · {since(m.occurredAt)}
                  </span>
                </>
              );
              return <li key={m.id}>{m.link ? <Link to={m.link} className="inv-move">{line}</Link> : <div className="inv-move">{line}</div>}</li>;
            })}
          </ul>
        )}
      </section>
    </div>
  );
}

/** Which view of the stock a viewer opened last — a per-browser convenience; a link's `?view=` wins. */
const INVENTORY_VIEW_KEY = 'gcore_view_inventory';
function storedInventoryView(): 'list' | 'kanban' {
  try {
    return localStorage.getItem(INVENTORY_VIEW_KEY) === 'kanban' ? 'kanban' : 'list';
  } catch {
    return 'list';
  }
}

export function Inventory() {
  const navigate = useNavigate();
  const { can } = useAuth();
  const [params, setParams] = useSearchParams();
  const asked = params.get('view');
  const view: 'list' | 'kanban' = asked === 'kanban' || asked === 'list' ? asked : storedInventoryView();
  const [warehouses, setWarehouses] = useState<{ id: string; name: string }[]>([]);

  function chooseView(next: 'list' | 'kanban') {
    try {
      localStorage.setItem(INVENTORY_VIEW_KEY, next);
    } catch {
      // A browser that keeps nothing still switches; it just will not remember.
    }
    const p = new URLSearchParams(params);
    p.set('view', next);
    p.delete('page');
    setParams(p, { replace: true });
  }

  useEffect(() => {
    api.get<typeof warehouses>('/warehouses').then(setWarehouses).catch(() => {});
  }, []);
  // The category tiles and the chart come with the list's summary.
  const [categories, setCategories] = useState<CategoryTile[]>([]);
  const [brands, setBrands] = useState<BrandTile[]>([]);
  const [importing, setImporting] = useState<{ entity: string; label: string; columns: never[] } | null>(null);
  const [reload, setReload] = useState(0);
  const chosenCategory = params.get('categoryId') ?? '';
  /** The list's own URL with the brand set — the valuation by brand's links. */
  const brandLink = (value: string) => {
    const p = new URLSearchParams(params);
    if (p.get('brand') === value) p.delete('brand');
    else p.set('brand', value);
    p.delete('page');
    return `/g-chain/inventory?${p.toString()}`;
  };
  // The projects' own goods (2026-10-18) — the same list on `?stock=project`.
  const projectStock = params.get('stock') === 'project';
  // What was bought for a sales order with no project (2026-10-21) — `?stock=order`.
  const orderStock = params.get('stock') === 'order';
  /** The list's own URL with the category set (or cleared, when it is the one chosen). */
  const categoryLink = (id: string) => {
    const p = new URLSearchParams(params);
    if (chosenCategory === id) p.delete('categoryId');
    else p.set('categoryId', id);
    p.delete('page');
    return `/g-chain/inventory?${p.toString()}`;
  };

  const columns: Column<StockRow>[] = [
    ...(projectStock
      ? [
          {
            key: 'project',
            label: 'Project',
            render: (s: StockRow) =>
              s.project ? (
                <div>
                  <Link to={`/g-ops/projects/${s.project.id}`} onClick={(e) => e.stopPropagation()} className="mono">
                    {s.project.number}
                  </Link>
                  <div className="faint">{s.project.name}</div>
                </div>
              ) : null,
          } as Column<StockRow>,
        ]
      : []),
    ...(orderStock
      ? [
          {
            key: 'salesOrder',
            label: 'Sales order',
            render: (s: StockRow) =>
              s.salesOrder ? (
                <div>
                  <Link to={`/g-ops/sales-orders/${s.salesOrder.id}`} onClick={(e) => e.stopPropagation()} className="mono">
                    {s.salesOrder.number}
                  </Link>
                  <div className="faint">{s.salesOrder.customer}</div>
                </div>
              ) : null,
          } as Column<StockRow>,
        ]
      : []),
    {
      key: 'code',
      label: 'Part number',
      render: (s) => (
        <div>
          <div className="mono">{s.item.partNumber ?? s.item.code}</div>
          {s.item.partNumber && <div className="faint mono">{s.item.code}</div>}
        </div>
      ),
    },
    {
      key: 'item',
      label: 'Item description',
      render: (s) => (
        <div>
          <div>{s.item.name}</div>
          {s.item.description && s.item.description !== s.item.name && <div className="faint">{s.item.description}</div>}
        </div>
      ),
    },
    { key: 'category', label: 'Category', render: (s) => s.item.category?.name ?? <span className="faint">—</span> },
    { key: 'brand', label: 'Brand / OEM', render: (s) => s.item.brand ?? <span className="faint">—</span> },
    { key: 'warehouse', label: 'Warehouse', render: (s) => s.warehouse.name, optional: true },
    { key: 'bin', label: 'Bin / Rack', render: (s) => (s.location ? <span className="mono">{s.location.code}</span> : <span className="faint">—</span>) },
    {
      key: 'available',
      label: 'Stock qty',
      align: 'right',
      render: (s) => (
        <span className={`mono${s.needsReorder ? ' proc-short' : ''}`}>
          {s.available} {s.item.unit}
          {s.borrowedQty ? <div className="faint">{s.borrowedQty} on loan</div> : null}
        </span>
      ),
    },
    { key: 'averageCost', label: 'Unit cost', align: 'right', render: (s) => <span className="mono">{formatMoney(s.averageCost)}</span> },
    { key: 'value', label: 'Value', align: 'right', render: (s) => <span className="mono">{formatMoney(s.value)}</span>, optional: true },
    {
      key: 'reorder',
      label: 'Reorder pt',
      align: 'right',
      render: (s) =>
        s.item.reorderLevel != null ? (
          <span className="mono">
            {s.item.reorderLevel} {s.item.unit}
          </span>
        ) : (
          <span className="faint">—</span>
        ),
    },
    {
      key: 'status',
      label: 'Status',
      render: (s) => <StatusBadge status={s.state} extra={STOCK_STATE_TONES} label={stateLabel(s.state)} />,
    },
  ];

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Inventory</h1>
        </div>
        {/* List or Kanban (2026-10-14, the owner's call) — one query behind both. */}
        <div className="scope-switch" role="group" aria-label="View">
          <button type="button" className={view === 'list' ? 'active' : ''} aria-pressed={view === 'list'} onClick={() => chooseView('list')}>
            List
          </button>
          <button type="button" className={view === 'kanban' ? 'active' : ''} aria-pressed={view === 'kanban'} onClick={() => chooseView('kanban')}>
            Kanban
          </button>
        </div>
      </div>

      <DataList<StockRow>
          listKey="inventory"
          endpoint="/inventory"
          printPath="/api/inventory/pdf"
        reportPath="/g-chain/reports?kind=inventory"
          columns={columns}
          rowKey={(s) => s.id}
          searchPlaceholder="Search item name, code, part number…"
          onRowClick={(s) =>
            navigate(
              `/g-chain/inventory/${s.item.id}?warehouseId=${s.warehouse.id}${s.project ? `&jobId=${s.project.id}` : ''}${s.salesOrder ? `&salesOrderId=${s.salesOrder.id}` : ''}`,
            )
          }
          emptyTitle={projectStock ? 'No project stock' : 'No stock yet'}
          emptyHint={
            projectStock
              ? 'Goods bought for a project appear here once their incoming report into a warehouse is approved.'
              : 'Stock appears once an incoming report into a warehouse is approved. Goods bought for a project show under Stock › Project stock.'
          }
          actions={
            projectStock ? (
              can('gchain.pullout_slips.create') ? (
                <Link className="btn btn-primary btn-sm" to="/g-chain/pullout-slips/new?kind=project">
                  + New pull-out slip
                </Link>
              ) : undefined
            ) : can('gchain.receiving.create') ? (
              <Link className="btn btn-primary btn-sm" to="/g-chain/incoming/new">
                + New incoming
              </Link>
            ) : undefined
          }
          reloadToken={reload}
          menuItems={
            can('gchain.items.create')
              ? [
                  {
                    label: 'Import from Odoo…',
                    hint: "Odoo's product export as it comes (.xlsx or .csv) — the items, their brand and group, and the opening stock in the main-office warehouse; checked before anything is saved",
                    onSelect: () => {
                      void loadImportSpec('odoo_inventory').then((spec) => {
                        if (spec) setImporting({ entity: 'odoo_inventory', ...(spec as { label: string; columns: never[] }) });
                      });
                    },
                  },
                  {
                    label: 'Import pictures from Odoo…',
                    hint: "Odoo's export with Name and Image (image_1920) — a picture for each item and G-HR asset of that name that has none yet; export a few hundred products a file, under 95 MB",
                    onSelect: () => {
                      void loadImportSpec('odoo_pictures').then((spec) => {
                        if (spec) setImporting({ entity: 'odoo_pictures', ...(spec as { label: string; columns: never[] }) });
                      });
                    },
                  },
                ]
              : []
          }
          onSummary={(raw) => {
            setCategories(((raw as InventorySummary).categories ?? []) as CategoryTile[]);
            setBrands((raw as InventorySummary).brands ?? []);
          }}
          summary={(raw) => {
            const sum = raw as InventorySummary;
            const tiles = sum.categories ?? [];
            if (sum.stock === 'order') {
              return (
                <>
                  <Stat label="Sales order stock" value={sum.items ?? 0} sub="Items held for sales orders" />
                  <Stat label="Sales orders" value={sum.orders ?? 0} sub="With goods on the shelves" />
                  <Stat label="Value" value={formatMoney(sum.valuation ?? 0)} sub="Counted against each order's quoted cost" />
                </>
              );
            }
            if (sum.stock === 'project') {
              return (
                <>
                  <Stat label="Project stock" value={sum.items ?? 0} sub="Items held for projects" />
                  <Stat label="Projects" value={sum.projects ?? 0} sub="With goods on the shelves" />
                  <Stat label="Value" value={formatMoney(sum.valuation ?? 0)} sub="Already charged to the projects" />
                </>
              );
            }
            return (
              <>
                <Stat label="Total items" value={sum.items ?? 0} sub="Every item, stocked or not" />
                <Stat label="Total valuation" value={formatMoney(sum.valuation ?? 0)} sub="Commercial stock" />
                <Stat label="Reorder warning" value={sum.lowStock ?? 0} sub="Below reorder level" accent="warn" to="/g-chain/inventory?state=LOW_STOCK" />
                <Stat label="Critical" value={sum.critical ?? 0} sub="Nothing left, or under the minimum" accent="danger" to="/g-chain/inventory?state=CRITICAL" />
                <Stat label="Out of stock" value={sum.outOfStock ?? 0} sub="Nothing on the shelf, no level set" to="/g-chain/inventory?state=OUT_OF_STOCK" />
                <Stat label="Pending POs" value={sum.pendingOrders ?? 0} sub={`In transit${sum.onOrder ? ` · ${sum.onOrder} low items on order` : ''}`} to="/g-chain/purchase-orders?awaiting=true" />
                <Stat
                  label="Project stock"
                  value={sum.projectStock?.lines ?? 0}
                  sub={`${sum.projectStock?.projects ?? 0} project(s) · ${formatMoney(sum.projectStock?.value ?? 0)}, charged to them`}
                  to="/g-chain/inventory?stock=project"
                />
                {tiles.length > 0 && (
                  <div className="inv-cats">
                    <div className="inv-cats-head">
                      <span>Inventory categories</span>
                      <span className="faint">{tiles.length} categor{tiles.length === 1 ? 'y' : 'ies'}</span>
                    </div>
                    <div className="inv-cats-grid">
                      {tiles.map((t) => (
                        <Link key={t.id} to={categoryLink(t.id)} className={`inv-cat${chosenCategory === t.id ? ' is-on' : ''}`} aria-pressed={chosenCategory === t.id}>
                          <span className="inv-cat-name">{t.name}</span>
                          <span className="inv-cat-count">{t.items}</span>
                          {t.description && <span className="inv-cat-desc">{t.description}</span>}
                          {(t.low > 0 || t.critical > 0) && (
                            <span className="inv-cat-flags">
                              {t.critical > 0 && <span className="badge danger">{t.critical} critical</span>}
                              {t.low > 0 && <span className="badge warn">{t.low} low</span>}
                            </span>
                          )}
                        </Link>
                      ))}
                    </div>
                  </div>
                )}
              </>
            );
          }}
          filters={[
            {
              key: 'stock',
              label: 'Stock',
              options: [
                { value: 'company', label: 'Company stock' },
                { value: 'project', label: 'Project stock' },
                { value: 'order', label: 'Sales order stock' },
              ],
            },
            {
              key: 'categoryId',
              label: 'Category',
              options: [...categories.filter((c) => c.id !== 'none').map((c) => ({ value: c.id, label: c.name })), { value: 'none', label: 'Not categorised' }],
            },
            {
              key: 'brand',
              label: 'Brand',
              options: brands.map((b) => ({ value: b.value, label: b.label })),
            },
            {
              key: 'state',
              label: 'Stock status',
              options: (Object.keys(STOCK_STATE_LABEL) as (keyof typeof STOCK_STATE_LABEL)[]).map((k) => ({ value: k, label: STOCK_STATE_LABEL[k] })),
            },
            {
              key: 'warehouseId',
              label: 'Warehouse',
              options: warehouses.map((w) => ({ value: w.id, label: w.name })),
            },
            { key: 'onHand', label: 'On hand', options: [{ value: 'yes', label: 'In stock only' }, { value: 'no', label: 'Nothing on hand' }] },
            { key: 'needsReorder', label: 'Reorder', options: [{ value: 'true', label: 'Below level' }] },
          ]}
          // Kanban (2026-10-25, gasiontech's cards): the same rows, query and pages, drawn as product cards.
          renderRows={view === 'kanban' ? (rows) => <InventoryCards rows={rows} canEditItems={can('gchain.items.edit_all') || can('gchain.items.edit_own')} /> : undefined}
        />
      {view === 'list' && categories.some((c) => c.value > 0) && (
        <Panel title="Stock value by category" blurb="What each category holds, at moving average cost — and how many of its lines need reordering.">
          <BarList
            slices={categories.map((c) => ({
              label: `${c.name}${c.critical || c.low ? ` · ${[c.critical && `${c.critical} critical`, c.low && `${c.low} low`].filter(Boolean).join(', ')}` : ''}`,
              value: c.value,
              display: formatMoney(c.value),
              tone: c.critical ? 'danger' : c.low ? 'warn' : 'neon',
              to: categoryLink(c.id),
            }))}
          />
        </Panel>
      )}
      {view === 'list' && brands.some((b) => b.worth > 0) && (
        <Panel
          title="Stock value by brand"
          blurb={`What each brand holds, at moving average cost — “Trading” is stock that declares no brand.${brands.length > 15 ? ` The first 15 of ${brands.length}; the Brand filter has every one.` : ''}`}
        >
          <BarList
            slices={brands.slice(0, 15).map((b) => ({
              label: `${b.label} · ${b.items} item${b.items === 1 ? '' : 's'}`,
              value: b.worth,
              display: formatMoney(b.worth),
              tone: 'neon',
              to: brandLink(b.value),
            }))}
          />
        </Panel>
      )}
      {importing && (
        <ImportModal
          entity={importing.entity}
          label={importing.label}
          columns={importing.columns}
          onClose={() => setImporting(null)}
          onImported={() => setReload((r) => r + 1)}
        />
      )}
      <InventoryFoot />
    </div>
  );
}

/**
 * The stock as product cards (2026-10-25, the owner's call: "the Kanban style
 * from gasiontech G-CORE"): the list's own rows — its query, filters, search
 * and pages — each a card with the product's picture (its photo, else its
 * initials on its category's colour), the description, part number, group
 * and brand, the price a unit, what is on hand and coming in, who has it on
 * loan, and the stock state. The card opens the stock card; ✎ opens the item
 * for whoever may change it. No delete: an item is deleted on its own form,
 * by a super admin.
 */
function InventoryCards({ rows, canEditItems }: { rows: StockRow[]; canEditItems: boolean }) {
  if (!rows.length) return null;
  return (
    <div className="inv-tiles">
      {rows.map((s) => {
        const href = `/g-chain/inventory/${s.item.id}?warehouseId=${s.warehouse.id}${s.project ? `&jobId=${s.project.id}` : ''}${s.salesOrder ? `&salesOrderId=${s.salesOrder.id}` : ''}`;
        return (
          <article key={s.id} className="inv-tile">
            <Link to={href} className="inv-tile-main">
              <ProductPicture photoId={s.item.photoId} name={s.item.name} toneKey={s.item.category?.name ?? s.item.brand} className="inv-tile-pic" />
              <span className="inv-tile-body">
                <span className="inv-tile-name" title={s.item.name}>{s.item.name}</span>
                <span className="inv-tile-code mono">{s.item.partNumber ?? s.item.code}</span>
                {s.loans && s.loans.length > 0 && (
                  <span className="inv-tile-loan">{s.loans.map((l) => `${l.quantity} on loan — ${l.borrower} (${l.number})`).join(' · ')}</span>
                )}
                <span className="inv-tile-group">
                  {s.item.category?.name ?? 'Not categorised'}
                  {s.item.brand ? ` · ${s.item.brand}` : ''}
                </span>
                <span className="inv-tile-price">
                  <span className="mono">{formatMoney(s.unitPrice ?? s.averageCost)}</span> <span className="faint">/ {s.item.unit}</span>
                </span>
                <span className="inv-tile-figures">
                  <span>
                    <span className="inv-tile-label">On hand</span>
                    <span className="mono inv-tile-qty">
                      {s.quantity} {s.item.unit}
                    </span>
                  </span>
                  <span className="inv-tile-in">
                    <span className="inv-tile-label">Incoming</span>
                    <span className="mono inv-tile-qty">{s.incoming ? `+${s.incoming} ${s.item.unit}` : '—'}</span>
                  </span>
                </span>
                {s.project && <span className="faint">{s.project.number}'s own stock</span>}
                {s.salesOrder && <span className="faint">{s.salesOrder.number}'s own stock</span>}
              </span>
            </Link>
            <span className="inv-tile-foot">
              <StatusBadge status={s.state} extra={STOCK_STATE_TONES} label={stateLabel(s.state)} />
              {canEditItems && (
                <Link to={`/g-chain/items/${s.item.id}`} className="btn btn-sm btn-icon btn-ghost" aria-label={`Modify item ${s.item.name}`} title="Modify item">
                  ✎
                </Link>
              )}
            </span>
          </article>
        );
      })}
    </div>
  );
}

export function StockCard() {
  const { itemId } = useParams<{ itemId: string }>();
  const toast = useToast();
  const [params] = useSearchParams();
  const warehouseId = params.get('warehouseId');
  // A project's own stock of the item (2026-10-18): its card alone.
  const jobId = params.get('jobId');
  // A sales order's own stock of the item (2026-10-21): its card alone.
  const salesOrderId = params.get('salesOrderId');
  const [data, setData] = useState<Record<string, unknown> | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    if (!itemId) return;
    api
      .get<Record<string, unknown>>(`/inventory/${itemId}/card${qs({ warehouseId, jobId, salesOrderId })}`)
      .then(setData)
      .catch(setError)
      .finally(() => setLoading(false));
  }, [itemId, warehouseId, jobId, salesOrderId]);

  if (loading) return <Loading />;
  if (!data) return <ErrorBox error={error ?? new Error('Not found')} />;

  const item = data.item as { code: string; name: string; unit: string; reorderLevel: number | null; photoId?: string | null; category?: { code: string } | null };
  const balances = data.balances as {
    id: string;
    quantity: number;
    borrowedQty: number;
    averageCost: number;
    value: number;
    warehouse: { name: string; locations: { id: string; code: string; name: string | null }[] };
    location: { id: string; code: string } | null;
  }[];
  const project = data.project as { id: string; number: string; name: string } | null | undefined;
  // Edit All places any stock line; Edit Own the items the viewer added (2026-10-18, the card's `canEdit`).
  const mayPlace = data.canEdit === true && !jobId && !salesOrderId;
  const salesOrder = data.salesOrder as { id: string; number: string } | null | undefined;
  /** Files the stock line in a bin (2026-10-15). */
  async function placeIn(balanceId: string, locationId: string) {
    try {
      await api.patch(`/inventory/balances/${balanceId}`, { locationId: locationId || null });
      toast('ok', locationId ? 'Bin saved' : 'Bin cleared');
      setData(await api.get<Record<string, unknown>>(`/inventory/${itemId}/card${qs({ warehouseId })}`));
    } catch (err) {
      setError(err);
    }
  }
  const movements = data.movements as {
    id: string;
    type: string;
    quantity: number;
    unitCost: number;
    balanceAfter: number;
    sourceType: string;
    sourceNumber: string | null;
    occurredAt: string;
    warehouse: { name: string };
    createdBy: { name: string } | null;
  }[];

  return (
    <div>
      <RecordHeader
        type="Stock Card"
        code={item.code}
        title={item.name}
        meta={
          salesOrderId ? (
            <>
              {salesOrder ? <Link to={`/g-ops/sales-orders/${salesOrder.id}`}>{salesOrder.number}</Link> : 'A sales order'}'s own stock — bought for the order,
              counted against its quoted cost · <Link to={`/g-chain/inventory/${itemId}`}>The company’s stock of it</Link>
            </>
          ) : jobId ? (
            <>
              {project ? (
                <>
                  <Link to={`/g-ops/projects/${project.id}`}>{project.number}</Link>'s own stock — charged to the project when it arrived
                </>
              ) : (
                'A project’s own stock'
              )}{' '}
              · <Link to={`/g-chain/inventory/${itemId}`}>The company’s stock of it</Link>
            </>
          ) : warehouseId ? (
            <>
              One warehouse only · <Link to={`/g-chain/inventory/${itemId}`}>Show every warehouse</Link>
            </>
          ) : (
            'Every warehouse'
          )
        }
      />

      <ErrorBox error={error} />

      {!jobId && !salesOrderId && (
        <PhotoCard
          path={`/items/${itemId}/photo`}
          label="Product photo"
          shownOn="The cards and the stock card show"
          name={item.name}
          photoId={item.photoId ?? null}
          toneKey={item.category?.code ?? null}
          canEdit={data.canEditPhoto === true}
          onChanged={(photoId) => setData({ ...data, item: { ...item, photoId } })}
          onError={setError}
        />
      )}

      <div className="kpi-grid proc-stats">
        {balances.map((b) => (
          <Stat
            key={b.id}
            label={b.warehouse.name}
            value={
              <>
                {b.quantity} <span className="faint proc-balance-unit">{item.unit}</span>
              </>
            }
            sub={
              <>
                {`${formatMoney(b.averageCost)} average · ${formatMoney(b.value)} value${b.borrowedQty > 0 ? ` · ${b.borrowedQty} on loan` : ''}`}
                <span className="inv-bin">
                  Bin / Rack:{' '}
                  {mayPlace && b.warehouse.locations.length ? (
                    <select aria-label={`Bin at ${b.warehouse.name}`} value={b.location?.id ?? ''} onChange={(e) => void placeIn(b.id, e.target.value)}>
                      <option value="">— none —</option>
                      {b.warehouse.locations.map((l) => (
                        <option key={l.id} value={l.id}>
                          {l.code}
                          {l.name ? ` — ${l.name}` : ''}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <span className="mono">{b.location?.code ?? '—'}</span>
                  )}
                </span>
              </>
            }
          />
        ))}
      </div>

      <div className="card">
        <h3 className="card-title">Movements</h3>
        {movements.length === 0 ? (
          <Empty title="No movements yet" />
        ) : (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th className="proc-col-when">When</th>
                  <th>Type</th>
                  <th>Reference</th>
                  <th>Warehouse</th>
                  <th className="right">In / out</th>
                  <th className="right">Unit cost</th>
                  <th className="right">Balance</th>
                  <th>By</th>
                </tr>
              </thead>
              <tbody>
                {movements.map((m) => (
                  <tr key={m.id}>
                    <td className="muted">{formatDateTime(m.occurredAt)}</td>
                    <td>
                      <span
                        className={`badge ${m.quantity > 0 ? 'ok' : m.type === 'BORROW' ? 'warn' : ''}`}
                      >
                        {label(m.type)}
                      </span>
                    </td>
                    <td className="mono faint">{m.sourceNumber ?? m.sourceType}</td>
                    <td>{m.warehouse.name}</td>
                    <td className={`right mono ${m.quantity > 0 ? 'proc-best' : 'proc-over'}`}>
                      {m.quantity > 0 ? '+' : ''}
                      {m.quantity}
                    </td>
                    <td className="right mono">{formatMoney(m.unitCost)}</td>
                    <td className="right mono">{m.balanceAfter}</td>
                    <td className="faint">{m.createdBy?.name ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Reports ──────────────────────────────────────────────────────────────────

// Reports live in ChainReports.tsx (2026-10-15): one report per menu over a chosen range.

interface ChainOverview {
  requestsAwaitingApproval: number | null;
  ordersAwaitingDelivery: number | null;
  borrowSlipsOverdue: number | null;
  stock: { value: number; lines: number } | null;
}

/** What a tile says when the caller cannot open the list behind it. */
const NOT_YOURS = 'not in your access — ask an administrator if you need it';

/**
 * G-CHAIN landing — the pipeline at a glance.
 *
 * Reads `GET /gchain/overview`, where the figures are decided once
 * (shared/chain.ts). It used to fire four list calls and swallow any failure,
 * so one 403 turned three tiles into a confident zero. A figure the caller
 * cannot see now comes back null and prints "—" with a note, never 0.
 */
export function ChainDashboard() {
  const [data, setData] = useState<ChainOverview | null>(null);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    api.get<ChainOverview>('/gchain/overview').then(setData).catch(setError);
  }, []);

  if (error) return <ErrorBox error={error} />;
  if (!data) return <Loading />;

  const count = (n: number | null) => n ?? 0;
  const tiles = [
    {
      label: 'Requests awaiting approval',
      icon: 'document' as const,
      more: 'Open requests',
      value: data.requestsAwaitingApproval,
      sub:
        data.requestsAwaitingApproval === null
          ? NOT_YOURS
          : count(data.requestsAwaitingApproval) > 0
            ? 'nothing can be ordered until these clear'
            : 'queue is clear',
      accent: count(data.requestsAwaitingApproval) > 0 ? ('warn' as const) : ('quiet' as const),
      to: '/g-chain/purchase-requests?status=PENDING_APPROVAL',
    },
    {
      label: 'Orders awaiting delivery',
      icon: 'cart' as const,
      more: 'Open orders',
      value: data.ordersAwaitingDelivery,
      sub: data.ordersAwaitingDelivery === null ? NOT_YOURS : 'issued or part-received',
      accent: count(data.ordersAwaitingDelivery) > 0 ? ('info' as const) : ('quiet' as const),
      to: '/g-chain/purchase-orders?awaiting=true',
    },
    {
      label: 'Overdue borrow slips',
      icon: 'wrench' as const,
      more: 'Open borrow slips',
      value: data.borrowSlipsOverdue,
      sub:
        data.borrowSlipsOverdue === null
          ? NOT_YOURS
          : count(data.borrowSlipsOverdue) > 0
            ? 'tools out past their return date'
            : 'everything back on time',
      accent: count(data.borrowSlipsOverdue) > 0 ? ('danger' as const) : ('quiet' as const),
      to: '/g-chain/borrow-slips?overdue=true',
    },
    {
      label: 'Stock on hand',
      icon: 'box' as const,
      more: 'Open inventory',
      value: data.stock ? formatMoney(data.stock.value) : null,
      sub: data.stock
        ? `${data.stock.lines} item line${data.stock.lines === 1 ? '' : 's'}, at moving average cost`
        : NOT_YOURS,
      accent: 'quiet' as const,
      figure: true,
      to: '/g-chain/inventory',
    },
  ];
  const hidden = tiles.filter((t) => t.value === null).length;

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>G-CHAIN</h1>
          <p>
            Request → canvass → order → receive → stock → issue. Every step links to the next, and
            the cost reaches a project exactly once.
          </p>
        </div>
      </div>

      <div className="kpi-grid">
        {tiles.map((t) => (
          <Stat
            key={t.label}
            label={t.label}
            value={t.value}
            sub={t.sub}
            accent={t.accent}
            icon={t.icon}
            figure={'figure' in t ? t.figure : undefined}
            // A tile whose list the caller cannot open is not a link.
            more={t.value === null ? undefined : t.more}
            to={t.value === null ? undefined : t.to}
          />
        ))}
      </div>
      {hidden > 0 && (
        <p className="faint proc-tile-note">
          A dash means the list behind that figure is outside your access — it is not zero.
        </p>
      )}

      <div className="card">
        <h3 className="card-title">How the money flows</h3>
        <div className="stack proc-flow">
          <div>
            <strong>Direct to job</strong> — approving the request{' '}
            <em>commits</em> the budget at estimated prices; issuing the order replaces that with the
            agreed price; receiving the goods turns it into <em>incurred</em> cost.
          </div>
          <div>
            <strong>Stock replenishment</strong> — nothing touches a
            project. Receiving adds to inventory at cost; issuing to a job charges it at the moving
            average.
          </div>
          <div className="faint">
            Material is therefore never charged to a project twice, whichever route it took.
          </div>
        </div>
      </div>
    </div>
  );
}
