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
  StatusBadge,
  formatDate,
  formatDateTime,
  formatMoney,
  useToast,
} from '../../components/ui';
import { Stat } from '../../components/charts';
import { RecordHeader } from '../../components/RecordHeader';
import { useConfirm } from '../../components/Confirm';
import { label } from './PurchaseRequests';
import { NumberInput } from '../../components/NumberInput';

// ════════════════════════════════════════════════════════════════════
//  RECEIVING
// ════════════════════════════════════════════════════════════════════

interface ReceivingRow {
  id: string;
  number: string;
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
  };
  warehouse: { id: string; name: string } | null;
  receivedBy: { id: string; name: string };
}

export function Receivings() {
  const navigate = useNavigate();

  const columns: Column<ReceivingRow>[] = [
    { key: 'number', label: 'Number', sortKey: 'number', width: '160px', render: (r) => <span className="mono">{r.number}</span> },
    {
      key: 'order',
      label: 'Against',
      render: (r) => (
        <div>
          <div>{r.order.supplier.name}</div>
          <div className="faint mono">{r.order.number}</div>
        </div>
      ),
    },
    { key: 'for', label: 'For', render: (r) => r.order.job ? `${r.order.job.number}` : <span className="faint">Stock</span> },
    { key: 'warehouse', label: 'Into', render: (r) => r.warehouse?.name ?? <span className="faint">site</span> },
    { key: 'receivedDate', label: 'Received', sortKey: 'receivedDate', render: (r) => formatDate(r.receivedDate) },
    { key: 'lines', label: 'Lines', align: 'right', render: (r) => r.lineCount },
    { key: 'value', label: 'Value', align: 'right', render: (r) => <span className="mono">{formatMoney(r.value)}</span> },
    { key: 'receivedBy', label: 'By', render: (r) => r.receivedBy.name },
    { key: 'ref', label: 'DR no.', render: (r) => r.deliveryRefNo ?? '—', optional: true },
  ];

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Receiving</h1>
        </div>
      </div>

      <DataList<ReceivingRow>
        listKey="receivings"
        endpoint="/receivings"
        printPath="/api/receivings/pdf"
        columns={columns}
        rowKey={(r) => r.id}
        searchPlaceholder="Search number, order, supplier…"
        onRowClick={(r) => navigate(`/g-chain/receiving/${r.id}`)}
        emptyTitle="Nothing received yet"
        emptyHint="Receive against an issued purchase order."
      />
    </div>
  );
}

export function ReceivingDetail() {
  const { id } = useParams<{ id: string }>();
  const { can } = useAuth();
  const toast = useToast();
  const [rec, setRec] = useState<Record<string, unknown> | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [modifying, setModifying] = useState(false);

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
  };
  // Empty unless the caller holds gfin.ap.view_all (billsVisible says which).
  const bills = (rec.bills ?? []) as { id: string; number: string; status: string }[];
  const billsVisible = rec.billsVisible === true;
  // One bill per delivery is the norm; offer to enter it until one exists.
  // Someone who cannot see bills can still enter one — the AP screen decides.
  const canEnterBill = can('gfin.ap.create') && (!billsVisible || bills.length === 0);
  const items = rec.items as {
    id: string;
    quantity: number;
    unitCost: number;
    amount: number;
    serialNo: string | null;
    batchNo: string | null;
    orderItem: { description: string; item: { code: string } | null; costCategory: { name: string } | null };
  }[];

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
        type="Receiving"
        code={String(rec.number)}
        title={order.supplier.name}
        amount={formatMoney(Number(rec.value))}
        amountLabel="Value received"
        meta={
          <>
            Against <Link to={`/g-chain/purchase-orders/${order.id}`}>{order.number}</Link> ·{' '}
            {order.job ? (
              <Link to={`/g-ops/projects/${order.job.id}`}>
                {order.job.number} — {order.job.name}
              </Link>
            ) : (
              'Stock'
            )}{' '}
            · from <Link to={`/g-chain/suppliers/${order.supplier.id}`}>{order.supplier.name}</Link> · received{' '}
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
          canEnterBill && (
            // The bill picks up the supplier, order and these goods from the
            // receiving, and — because it names the receiving — posts no job
            // cost a second time.
            <Link to={`/g-fin/ap?fromReceiving=${String(rec.id)}`} className="btn btn-primary">
              Enter supplier bill
            </Link>
          )
        }
        // Its references only: what arrived is the record.
        modify={rec.canEdit === true ? () => setModifying(true) : undefined}
      />

      <ErrorBox error={error} />

      <div className={`alert ${order.kind === 'DIRECT_TO_JOB' ? 'ok' : 'info'}`}>
        {order.kind === 'DIRECT_TO_JOB'
          ? `${formatMoney(Number(rec.value))} charged to ${order.job?.number ?? 'the project'}, and the same released from committed.`
          : `${formatMoney(Number(rec.value))} added to stock. No project has been charged — that happens at issuance.`}
      </div>

      {refs.notes && (
        <div className="card proc-card">
          <h3 className="card-title">Notes</h3>
          <p className="activity-notes">{refs.notes}</p>
        </div>
      )}

      <div className="card">
        <h3 className="card-title">Items received</h3>
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>Item</th>
                <th>Budget line</th>
                <th className="right">Qty</th>
                <th className="right">Unit cost</th>
                <th className="right">Amount</th>
                <th>Serial / batch</th>
              </tr>
            </thead>
            <tbody>
              {items.map((i) => (
                <tr key={i.id}>
                  <td>
                    <div>{i.orderItem.description}</div>
                    {i.orderItem.item && <div className="faint mono">{i.orderItem.item.code}</div>}
                  </td>
                  <td>{i.orderItem.costCategory?.name ?? <span className="faint">—</span>}</td>
                  <td className="right mono">{i.quantity}</td>
                  <td className="right mono">{formatMoney(i.unitCost)}</td>
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

// ════════════════════════════════════════════════════════════════════
//  STOCK ISSUANCE
// ════════════════════════════════════════════════════════════════════

interface IssueRow {
  id: string;
  number: string;
  status: string;
  issueDate: string;
  purpose: string;
  issuedToName: string | null;
  lineCount: number;
  value: number;
  job: { id: string; number: string; name: string } | null;
  warehouse: { id: string; name: string };
  issuedBy: { id: string; name: string };
}

export function StockIssues() {
  const { can } = useAuth();
  const navigate = useNavigate();
  const [creating, setCreating] = useState(false);
  const [reload, setReload] = useState(0);

  const columns: Column<IssueRow>[] = [
    { key: 'number', label: 'Number', sortKey: 'number', width: '160px', render: (i) => <span className="mono">{i.number}</span> },
    {
      key: 'purpose',
      label: 'Issue',
      render: (i) => (
        <div>
          <div>{i.purpose}</div>
          <div className="faint">{i.job ? `${i.job.number} — ${i.job.name}` : 'No project'}</div>
        </div>
      ),
    },
    { key: 'warehouse', label: 'From', render: (i) => i.warehouse.name },
    { key: 'issuedTo', label: 'To', render: (i) => i.issuedToName ?? <span className="faint">—</span> },
    { key: 'issueDate', label: 'Date', sortKey: 'issueDate', render: (i) => formatDate(i.issueDate) },
    { key: 'lines', label: 'Lines', align: 'right', render: (i) => i.lineCount },
    { key: 'value', label: 'Value', align: 'right', render: (i) => <span className="mono">{formatMoney(i.value)}</span> },
    {
      key: 'status',
      label: 'Status',
      render: (i) => <StatusBadge status={i.status} />,
    },
  ];

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Stock Issuance</h1>
        </div>
      </div>

      <DataList<IssueRow>
        listKey="stock-issues"
        endpoint="/stock-issues"
        printPath="/api/stock-issues/pdf"
        columns={columns}
        rowKey={(i) => i.id}
        searchPlaceholder="Search number, purpose, project…"
        reloadToken={reload}
        onRowClick={(i) => navigate(`/g-chain/stock-issuance/${i.id}`)}
        emptyTitle="Nothing issued yet"
        emptyHint="Stock issued to a project charges it here, at the moving average cost."
        filters={[
          {
            key: 'status',
            label: 'Status',
            options: [
              { value: 'DRAFT', label: 'Draft' },
              { value: 'ISSUED', label: 'Issued' },
            ],
          },
        ]}
        actions={
          can('gchain.stock_issuance.create') ? (
            <button className="btn btn-primary btn-sm" onClick={() => setCreating(true)}>
              + New stock issue
            </button>
          ) : null
        }
      />

      {creating && (
        <IssueModal
          onClose={() => setCreating(false)}
          onSaved={(id) => {
            setCreating(false);
            setReload((r) => r + 1);
            navigate(`/g-chain/stock-issuance/${id}`);
          }}
        />
      )}
    </div>
  );
}

/** The draft being modified, as the issue page holds it. */
interface IssueHeader {
  id: string;
  number: string;
  purpose: string;
  issuedToName: string | null;
  issueDate: string;
  lineCount: number;
  job: { id: string; number: string; name: string } | null;
  warehouse: { id: string; name: string };
}

/**
 * New stock issue, or — given `existing` — Modify a draft. Nothing has moved
 * yet, so all of it may change: a new warehouse re-prices the lines at its
 * average, and a project needs every line's cost bucket (the API says which
 * item has none).
 */
function IssueModal({
  existing,
  onClose,
  onSaved,
}: {
  existing?: IssueHeader;
  onClose: () => void;
  onSaved: (id: string) => void;
}) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [jobs, setJobs] = useState<{ id: string; number: string; name: string }[]>([]);
  const [warehouses, setWarehouses] = useState<{ id: string; name: string }[]>([]);
  const [form, setForm] = useState({
    jobId: existing?.job?.id ?? '',
    warehouseId: existing?.warehouse.id ?? '',
    issuedToName: existing?.issuedToName ?? '',
    purpose: existing?.purpose ?? '',
    issueDate: existing ? existing.issueDate.slice(0, 10) : '',
  });

  useEffect(() => {
    api.get<typeof jobs>('/jobs/lookup').then(setJobs).catch(() => {});
    api
      .get<typeof warehouses>('/warehouses')
      .then((w) => {
        setWarehouses(w);
        if (w.length === 1) setForm((f) => (f.warehouseId ? f : { ...f, warehouseId: w[0].id }));
      })
      .catch(() => {});
  }, []);

  async function save() {
    setBusy(true);
    setError(null);
    const body = {
      jobId: form.jobId || null,
      warehouseId: form.warehouseId,
      issuedToName: form.issuedToName || null,
      purpose: form.purpose,
    };
    try {
      if (existing) {
        await api.patch(`/stock-issues/${existing.id}`, { ...body, issueDate: form.issueDate || null });
        toast('ok', `${existing.number} updated`);
        onSaved(existing.id);
      } else {
        const created = await api.post<{ id: string }>('/stock-issues', body);
        onSaved(created.id);
      }
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  }

  // The issue's own project and warehouse stay pickable even when the
  // lookups leave them out.
  const jobOptions =
    existing?.job && !jobs.some((j) => j.id === existing.job!.id) ? [existing.job, ...jobs] : jobs;
  const warehouseOptions =
    existing && !warehouses.some((w) => w.id === existing.warehouse.id)
      ? [existing.warehouse, ...warehouses]
      : warehouses;
  const moving = !!existing && existing.lineCount > 0 && form.warehouseId !== existing.warehouse.id;

  return (
    <Modal
      title={existing ? `Modify stock issue ${existing.number}` : 'New stock issue'}
      onClose={onClose}
      footer={
        <ModalFoot onCancel={onClose} busy={busy}>
          <button
            className="btn btn-primary"
            onClick={save}
            disabled={busy || !form.warehouseId || form.purpose.trim().length < 3}
          >
            {busy ? 'Saving…' : 'Save'}
          </button>
        </ModalFoot>
      }
    >
      <ErrorBox error={error} />
      <Field
        label="From warehouse"
        hint={moving ? 'The lines are re-priced at this warehouse’s average cost' : undefined}
      >
        <select value={form.warehouseId} onChange={(e) => setForm({ ...form, warehouseId: e.target.value })}>
          <option value="">— choose —</option>
          {warehouseOptions.map((w) => (
            <option key={w.id} value={w.id}>
              {w.name}
            </option>
          ))}
        </select>
      </Field>
      <Field label="For project" hint="Leave blank for general use — no job is charged">
        <select value={form.jobId} onChange={(e) => setForm({ ...form, jobId: e.target.value })}>
          <option value="">— none —</option>
          {jobOptions.map((j) => (
            <option key={j.id} value={j.id}>
              {j.number} — {j.name}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Issued to">
        <input value={form.issuedToName} onChange={(e) => setForm({ ...form, issuedToName: e.target.value })} />
      </Field>
      <Field label="Purpose">
        <input value={form.purpose} onChange={(e) => setForm({ ...form, purpose: e.target.value })} />
      </Field>
      {existing && (
        <Field label="Date">
          <input type="date" value={form.issueDate} onChange={(e) => setForm({ ...form, issueDate: e.target.value })} />
        </Field>
      )}
    </Modal>
  );
}

export function StockIssueDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const toast = useToast();
  const confirm = useConfirm();
  const [issue, setIssue] = useState<Record<string, unknown> | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [adding, setAdding] = useState(false);
  const [modifying, setModifying] = useState(false);

  const load = useCallback(async () => {
    if (!id) return;
    try {
      setIssue(await api.get<Record<string, unknown>>(`/stock-issues/${id}`));
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
  if (!issue) return <ErrorBox error={error ?? new Error('Not found')} />;

  const job = issue.job as { id: string; number: string; name: string } | null;
  const warehouse = issue.warehouse as { id: string; name: string };
  const items = issue.items as {
    id: string;
    quantity: number;
    unitCost: number;
    amount: number;
    item: { id: string; code: string; name: string; unit: string };
    costCategory: { name: string } | null;
  }[];
  const isDraft = issue.status === 'DRAFT';
  // The API's own rules: a draft, changed by the create or edit_all right and
  // deleted by the delete right. Issued stock has moved.
  const canEdit = issue.canEdit === true;
  const canDelete = issue.canDelete === true;
  const number = String(issue.number);
  const issuedTo = typeof issue.issuedToName === 'string' && issue.issuedToName ? issue.issuedToName : null;

  /** Asked in the confirm bar, which shows a refusal — so these throw rather than catching. */
  async function commit() {
    setIssue(await api.post<Record<string, unknown>>(`/stock-issues/${id}/issue`));
    toast('ok', job ? 'Issued — the project has been charged' : 'Issued');
    await load();
  }

  async function removeItem(itemRowId: string) {
    await api.del(`/stock-issues/${id}/items/${itemRowId}`);
    toast('ok', 'Item removed');
    await load();
  }

  async function remove() {
    await api.del(`/stock-issues/${id}`);
    toast('ok', `${number} deleted`);
    navigate('/g-chain/stock-issuance');
  }

  const addItemButton = canEdit ? (
    <button className="btn btn-sm" onClick={() => setAdding(true)}>
      + Add item
    </button>
  ) : null;

  return (
    <div>
      <RecordHeader
        type="Stock Issue"
        code={number}
        title={String(issue.purpose)}
        status={String(issue.status)}
        amount={formatMoney(Number(issue.value))}
        amountLabel={isDraft ? 'Value at current cost' : 'Value issued'}
        meta={
          <>
            From {warehouse.name}
            {job && (
              <>
                {' '}
                →{' '}
                <Link to={`/g-ops/projects/${job.id}`}>
                  {job.number} — {job.name}
                </Link>
              </>
            )}
            {issuedTo ? ` · to ${issuedTo}` : ''} · {formatDate(String(issue.issueDate))}
          </>
        }
        actions={
          isDraft && (
            <button
              className="btn btn-primary"
              disabled={items.length === 0}
              title={items.length === 0 ? 'Add an item first' : undefined}
              onClick={() =>
                confirm.ask({
                  title: `Issue ${number}?`,
                  body: job
                    ? `The stock leaves ${warehouse.name} and ${formatMoney(Number(issue.value))} is charged to ${job.number} at the current average cost. It cannot be taken back.`
                    : `The stock leaves ${warehouse.name}. No project is charged. It cannot be taken back.`,
                  confirmLabel: 'Issue',
                  tone: 'primary',
                  onConfirm: commit,
                })
              }
            >
              Issue
            </button>
          )
        }
        print={`/api/stock-issues/${id}/pdf`}
        more={[
          canDelete && {
            label: 'Delete',
            danger: true,
            confirm: {
              title: `Delete ${number}?`,
              body: 'Nothing has left the store yet. It cannot be undone.',
              confirmLabel: 'Delete',
              onConfirm: remove,
            },
          },
        ]}
        modify={canEdit ? () => setModifying(true) : undefined}
        confirm={confirm}
      />

      <ErrorBox error={error} />

      {isDraft && job && (
        <div className="alert info">
          Nothing has moved yet. Issuing will take the stock out and charge{' '}
          {formatMoney(Number(issue.value))} to {job.number} at the current average cost.
        </div>
      )}

      <div className="card">
        <div className="proc-card-head">
          <h3 className="card-title">Items</h3>
          {items.length > 0 && addItemButton}
        </div>
        {items.length === 0 ? (
          <Empty
            title="No items yet"
            hint={isDraft ? 'Add what is leaving the store. Only what this warehouse holds can be issued.' : undefined}
            action={addItemButton ?? undefined}
          />
        ) : (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Item</th>
                  <th>Budget line</th>
                  <th className="right">Qty</th>
                  <th className="right">Unit cost</th>
                  <th className="right">Amount</th>
                  {canEdit && <th className="proc-col-actions" aria-label="Actions" />}
                </tr>
              </thead>
              <tbody>
                {items.map((i) => (
                  <tr key={i.id}>
                    <td>
                      <div>{i.item.name}</div>
                      <div className="faint mono">{i.item.code}</div>
                    </td>
                    <td>{i.costCategory?.name ?? <span className="faint">—</span>}</td>
                    <td className="right mono">
                      {i.quantity} {i.item.unit}
                    </td>
                    <td className="right mono">{formatMoney(i.unitCost)}</td>
                    <td className="right mono">{formatMoney(i.amount)}</td>
                    {canEdit && (
                      <td>
                        <div className="proc-row-actions">
                          <button
                            className="btn btn-sm"
                            aria-label={`Remove ${i.item.name}`}
                            onClick={() =>
                              confirm.ask({
                                title: `Remove ${i.item.name} from ${number}?`,
                                confirmLabel: 'Remove',
                                onConfirm: () => removeItem(i.id),
                              })
                            }
                          >
                            Remove
                          </button>
                        </div>
                      </td>
                    )}
                  </tr>
                ))}
                <tr>
                  <td colSpan={4} className="right">
                    <strong>TOTAL</strong>
                  </td>
                  <td className="right mono">
                    <strong>{formatMoney(Number(issue.value))}</strong>
                  </td>
                  {canEdit && <td />}
                </tr>
              </tbody>
            </table>
          </div>
        )}
      </div>

      {modifying && (
        <IssueModal
          existing={{
            id: String(id),
            number,
            purpose: String(issue.purpose),
            issuedToName: issuedTo,
            issueDate: String(issue.issueDate),
            lineCount: items.length,
            job,
            warehouse,
          }}
          onClose={() => setModifying(false)}
          onSaved={() => {
            setModifying(false);
            void load();
          }}
        />
      )}

      {adding && (
        <AddIssueItemModal
          issueId={String(id)}
          warehouseId={warehouse.id}
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

function AddIssueItemModal({
  issueId,
  warehouseId,
  onClose,
  onSaved,
}: {
  issueId: string;
  warehouseId: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [stock, setStock] = useState<
    { id: string; item: { id: string; code: string; name: string; unit: string }; available: number; averageCost: number }[]
  >([]);
  const [form, setForm] = useState({ itemId: '', quantity: '' });

  useEffect(() => {
    api
      .get<{ rows: typeof stock }>(`/inventory${qs({ warehouseId, pageSize: 200 })}`)
      .then((r) => setStock(r.rows))
      .catch(() => {});
  }, [warehouseId]);

  const chosen = stock.find((s) => s.item.id === form.itemId);

  async function save() {
    setBusy(true);
    setError(null);
    try {
      await api.post(`/stock-issues/${issueId}/items`, {
        itemId: form.itemId,
        quantity: Number(form.quantity),
      });
      onSaved();
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  }

  return (
    <Modal
      title="Add item"
      onClose={onClose}
      footer={
        <ModalFoot onCancel={onClose} busy={busy}>
          <button
            className="btn btn-primary"
            onClick={save}
            disabled={busy || !form.itemId || Number(form.quantity) <= 0}
          >
            {busy ? 'Saving…' : 'Save'}
          </button>
        </ModalFoot>
      }
    >
      <ErrorBox error={error} />
      <Field label="Item" hint="Only what this warehouse actually holds">
        <select value={form.itemId} onChange={(e) => setForm({ ...form, itemId: e.target.value })}>
          <option value="">— choose —</option>
          {stock
            .filter((s) => s.available > 0)
            .map((s) => (
              <option key={s.id} value={s.item.id}>
                {s.item.code} — {s.item.name} ({s.available} {s.item.unit} available)
              </option>
            ))}
        </select>
      </Field>
      {chosen && (
        <div className="alert info">
          {chosen.available} {chosen.item.unit} available at {formatMoney(chosen.averageCost)} each.
          {form.quantity && Number(form.quantity) > 0 && (
            <>
              {' '}
              Issuing {form.quantity} charges{' '}
              <strong>{formatMoney(Number(form.quantity) * chosen.averageCost)}</strong>.
            </>
          )}
        </div>
      )}
      <Field label="Quantity">
        <NumberInput
          kind="quantity"
          step="0.001"
          max={chosen?.available}
          value={form.quantity}
          onChange={(e) => setForm({ ...form, quantity: e.target.value })}
        />
      </Field>
    </Modal>
  );
}

// ════════════════════════════════════════════════════════════════════
//  BORROW SLIPS
// ════════════════════════════════════════════════════════════════════

interface BorrowRow {
  id: string;
  number: string;
  status: string;
  borrowerName: string;
  purpose: string;
  borrowedAt: string;
  dueAt: string;
  returnedAt: string | null;
  itemCount: number;
  outstandingQty: number;
  isOverdue: boolean;
  daysOverdue: number;
  job: { id: string; number: string; name: string } | null;
  warehouse: { id: string; name: string };
}

export function BorrowSlips() {
  const { can } = useAuth();
  const navigate = useNavigate();
  const [creating, setCreating] = useState(false);
  const [reload, setReload] = useState(0);

  const columns: Column<BorrowRow>[] = [
    { key: 'number', label: 'Number', sortKey: 'number', width: '160px', render: (b) => <span className="mono">{b.number}</span> },
    {
      key: 'borrower',
      label: 'Borrower',
      render: (b) => (
        <div>
          <div>{b.borrowerName}</div>
          <div className="faint">{b.purpose}</div>
        </div>
      ),
    },
    { key: 'job', label: 'Project', render: (b) => b.job?.number ?? <span className="faint">—</span> },
    { key: 'borrowedAt', label: 'Out', sortKey: 'borrowedAt', render: (b) => formatDate(b.borrowedAt) },
    {
      key: 'dueAt',
      label: 'Due back',
      sortKey: 'dueAt',
      render: (b) => (
        <span className={b.isOverdue ? 'proc-over' : undefined}>
          {formatDate(b.dueAt)}
          {b.isOverdue && <div className="faint">{b.daysOverdue}d overdue</div>}
        </span>
      ),
    },
    { key: 'items', label: 'Items', align: 'right', render: (b) => b.itemCount },
    { key: 'outstanding', label: 'Still out', align: 'right', render: (b) => b.outstandingQty || '—' },
    {
      key: 'status',
      label: 'Status',
      render: (b) => (
        <span className={`badge ${b.isOverdue ? 'danger' : b.status === 'RETURNED' ? 'ok' : 'warn'}`}>
          {b.isOverdue ? 'overdue' : label(b.status)}
        </span>
      ),
    },
  ];

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Borrow Slips</h1>
        </div>
      </div>

      <DataList<BorrowRow>
        listKey="borrow-slips"
        endpoint="/borrow-slips"
        printPath="/api/borrow-slips/pdf"
        columns={columns}
        rowKey={(b) => b.id}
        searchPlaceholder="Search number, borrower, purpose…"
        reloadToken={reload}
        onRowClick={(b) => navigate(`/g-chain/borrow-slips/${b.id}`)}
        emptyTitle="Nothing on loan"
        emptyHint="A borrow slip charges no job cost — the tool is on loan, not consumed."
        filters={[
          {
            key: 'status',
            label: 'Status',
            options: [
              { value: 'OUT', label: 'Out' },
              { value: 'PARTIALLY_RETURNED', label: 'Partly back' },
              { value: 'RETURNED', label: 'Returned' },
            ],
          },
          { key: 'overdue', label: 'Overdue', options: [{ value: 'true', label: 'Overdue only' }] },
        ]}
        actions={
          can('gchain.borrow_slips.create') ? (
            <button className="btn btn-primary btn-sm" onClick={() => setCreating(true)}>
              + New borrow slip
            </button>
          ) : null
        }
      />

      {creating && (
        <BorrowModal
          onClose={() => setCreating(false)}
          onCreated={() => {
            setCreating(false);
            setReload((r) => r + 1);
          }}
        />
      )}
    </div>
  );
}

/** A slip being modified: what may still change while anything is out. */
interface SlipHeader {
  id: string;
  number: string;
  borrowerName: string;
  dueAt: string;
  purpose: string;
  notes: string | null;
}

/**
 * New borrow slip, or — given `existing` — Modify one while anything on it
 * is still out: who has it, when it is due back, what for, the notes. The
 * warehouse and the items are fixed once lent, because the stock has moved.
 */
function BorrowModal({
  existing,
  onClose,
  onCreated,
}: {
  existing?: SlipHeader;
  onClose: () => void;
  onCreated: () => void;
}) {
  if (existing) return <ModifySlipForm slip={existing} onClose={onClose} onSaved={onCreated} />;
  return <NewSlipForm onClose={onClose} onCreated={onCreated} />;
}

function ModifySlipForm({ slip, onClose, onSaved }: { slip: SlipHeader; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [form, setForm] = useState({
    borrowerName: slip.borrowerName,
    dueAt: slip.dueAt.slice(0, 10),
    purpose: slip.purpose,
    notes: slip.notes ?? '',
  });

  async function save() {
    setBusy(true);
    setError(null);
    try {
      await api.patch(`/borrow-slips/${slip.id}`, {
        borrowerName: form.borrowerName.trim(),
        dueAt: form.dueAt,
        purpose: form.purpose.trim(),
        notes: form.notes.trim() || null,
      });
      toast('ok', `${slip.number} updated`);
      onSaved();
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  }

  return (
    <Modal
      title={`Modify borrow slip ${slip.number}`}
      onClose={onClose}
      footer={
        <ModalFoot onCancel={onClose} busy={busy}>
          <button
            className="btn btn-primary"
            onClick={save}
            disabled={busy || form.borrowerName.trim().length < 2 || !form.dueAt || form.purpose.trim().length < 3}
          >
            {busy ? 'Saving…' : 'Save'}
          </button>
        </ModalFoot>
      }
    >
      <ErrorBox error={error} />
      <div className="alert info">
        The warehouse and the items are fixed — the stock has already moved out of available.
      </div>
      <div className="grid grid-2">
        <Field label="Borrower">
          <input value={form.borrowerName} onChange={(e) => setForm({ ...form, borrowerName: e.target.value })} />
        </Field>
        <Field label="Due back">
          <input type="date" value={form.dueAt} onChange={(e) => setForm({ ...form, dueAt: e.target.value })} />
        </Field>
      </div>
      <Field label="Purpose">
        <input value={form.purpose} onChange={(e) => setForm({ ...form, purpose: e.target.value })} />
      </Field>
      <Field label="Notes">
        <textarea rows={3} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
      </Field>
    </Modal>
  );
}

function NewSlipForm({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [warehouses, setWarehouses] = useState<{ id: string; name: string }[]>([]);
  const [jobs, setJobs] = useState<{ id: string; number: string; name: string }[]>([]);
  const [stock, setStock] = useState<
    { id: string; item: { id: string; code: string; name: string; unit: string }; available: number }[]
  >([]);
  const [lines, setLines] = useState<{ itemId: string; quantity: string }[]>([{ itemId: '', quantity: '1' }]);
  const [form, setForm] = useState({
    warehouseId: '',
    jobId: '',
    borrowerName: '',
    dueAt: '',
    purpose: '',
  });

  useEffect(() => {
    api
      .get<typeof warehouses>('/warehouses')
      .then((w) => {
        setWarehouses(w);
        if (w.length === 1) setForm((f) => ({ ...f, warehouseId: w[0].id }));
      })
      .catch(() => {});
    api.get<typeof jobs>('/jobs/lookup').then(setJobs).catch(() => {});
  }, []);

  useEffect(() => {
    if (!form.warehouseId) return;
    api
      .get<{ rows: typeof stock }>(`/inventory${qs({ warehouseId: form.warehouseId, pageSize: 200 })}`)
      .then((r) => setStock(r.rows))
      .catch(() => {});
  }, [form.warehouseId]);

  async function create() {
    setBusy(true);
    setError(null);
    try {
      await api.post('/borrow-slips', {
        warehouseId: form.warehouseId,
        jobId: form.jobId || null,
        borrowerName: form.borrowerName,
        dueAt: form.dueAt,
        purpose: form.purpose,
        items: lines
          .filter((l) => l.itemId && Number(l.quantity) > 0)
          .map((l) => ({ itemId: l.itemId, quantity: Number(l.quantity) })),
      });
      toast('ok', 'Lent out');
      onCreated();
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  }

  const valid = lines.some((l) => l.itemId && Number(l.quantity) > 0);

  return (
    <Modal
      wide
      title="New borrow slip"
      onClose={onClose}
      footer={
        <ModalFoot onCancel={onClose} busy={busy}>
          {/* The form's one act is lending, so it keeps that verb. */}
          <button
            className="btn btn-primary"
            onClick={create}
            disabled={busy || !form.warehouseId || !form.borrowerName || !form.dueAt || !valid}
          >
            {busy ? 'Saving…' : 'Lend out'}
          </button>
        </ModalFoot>
      }
    >
      <ErrorBox error={error} />
      <div className="grid grid-2">
        <Field label="From warehouse">
          <select value={form.warehouseId} onChange={(e) => setForm({ ...form, warehouseId: e.target.value })}>
            <option value="">— choose —</option>
            {warehouses.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="For project" hint="Optional — recorded, but never charged">
          <select value={form.jobId} onChange={(e) => setForm({ ...form, jobId: e.target.value })}>
            <option value="">— none —</option>
            {jobs.map((j) => (
              <option key={j.id} value={j.id}>
                {j.number}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Borrower">
          <input value={form.borrowerName} onChange={(e) => setForm({ ...form, borrowerName: e.target.value })} />
        </Field>
        <Field label="Due back">
          <input type="date" value={form.dueAt} onChange={(e) => setForm({ ...form, dueAt: e.target.value })} />
        </Field>
      </div>
      <Field label="Purpose">
        <input value={form.purpose} onChange={(e) => setForm({ ...form, purpose: e.target.value })} />
      </Field>

      <div className="section-label proc-borrow-label">Items</div>
      {lines.map((l, i) => (
        <div key={i} className="row proc-borrow-line">
          <select
            className="proc-grow"
            aria-label={`Item ${i + 1}`}
            value={l.itemId}
            onChange={(e) => setLines(lines.map((x, n) => (n === i ? { ...x, itemId: e.target.value } : x)))}
          >
            <option value="">— choose —</option>
            {stock
              .filter((s) => s.available > 0)
              .map((s) => (
                <option key={s.id} value={s.item.id}>
                  {s.item.code} — {s.item.name} ({s.available} available)
                </option>
              ))}
          </select>
          <NumberInput
            kind="quantity"
            step="0.001"
            className="proc-qty"
            aria-label={`Quantity of item ${i + 1}`}
            value={l.quantity}
            onChange={(e) => setLines(lines.map((x, n) => (n === i ? { ...x, quantity: e.target.value } : x)))}
          />
          {/* An unsaved row of this form: nothing on record is lost, so no question. */}
          <button
            className="btn btn-sm"
            aria-label={`Remove item ${i + 1}`}
            onClick={() => setLines(lines.filter((_, n) => n !== i))}
            disabled={lines.length === 1}
          >
            Remove
          </button>
        </div>
      ))}
      <button className="btn btn-sm" onClick={() => setLines([...lines, { itemId: '', quantity: '1' }])}>
        + Add item
      </button>
    </Modal>
  );
}

export function BorrowSlipDetail() {
  const { id } = useParams<{ id: string }>();
  const toast = useToast();
  const { can } = useAuth();
  const [slip, setSlip] = useState<Record<string, unknown> | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [returns, setReturns] = useState<Record<string, string>>({});
  const [modifying, setModifying] = useState(false);

  const load = useCallback(async () => {
    if (!id) return;
    try {
      const s = await api.get<Record<string, unknown>>(`/borrow-slips/${id}`);
      setSlip(s);
      const items = s.items as { id: string; outstandingQty: number }[];
      setReturns(Object.fromEntries(items.map((i) => [i.id, String(i.outstandingQty)])));
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
  if (!slip) return <ErrorBox error={error ?? new Error('Not found')} />;

  const items = slip.items as {
    id: string;
    quantity: number;
    returnedQty: number;
    outstandingQty: number;
    serialNo: string | null;
    item: { id: string; code: string; name: string; unit: string };
  }[];
  const job = slip.job as { id: string; number: string } | null;
  const done = slip.status === 'RETURNED';
  const notes = typeof slip.notes === 'string' && slip.notes ? slip.notes : null;

  async function receiveBack() {
    try {
      await api.post(`/borrow-slips/${id}/return`, {
        items: items
          .filter((i) => Number(returns[i.id]) > 0)
          .map((i) => ({ itemId: i.id, quantity: Number(returns[i.id]) })),
      });
      toast('ok', 'Returned to stock');
      await load();
    } catch (err) {
      setError(err);
    }
  }

  return (
    <div>
      <RecordHeader
        type="Borrow Slip"
        code={String(slip.number)}
        title={String(slip.borrowerName)}
        status={String(slip.status)}
        statusExtra={{ RETURNED: 'ok' }}
        meta={
          <>
            {String(slip.purpose)}
            {job && (
              <>
                {' '}
                · <Link to={`/g-ops/projects/${job.id}`}>{job.number}</Link>
              </>
            )}{' '}
            · due {formatDate(String(slip.dueAt))}
          </>
        }
        // While anything is still out (the API's rule): who, when due, what for.
        modify={slip.canEdit === true ? () => setModifying(true) : undefined}
      />

      <ErrorBox error={error} />

      {notes && (
        <div className="card proc-card">
          <h3 className="card-title">Notes</h3>
          <p className="activity-notes">{notes}</p>
        </div>
      )}

      <div className="card">
        <h3 className="card-title">Items on loan</h3>
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>Item</th>
                <th className="right">Lent</th>
                <th className="right">Back</th>
                <th className="right">Still out</th>
                {!done && can('gchain.borrow_slips.edit_all') && (
                  <th className="right proc-col-input">Returning now</th>
                )}
              </tr>
            </thead>
            <tbody>
              {items.map((i) => (
                <tr key={i.id}>
                  <td>
                    <div>{i.item.name}</div>
                    <div className="faint mono">
                      {i.item.code}
                      {i.serialNo ? ` · ${i.serialNo}` : ''}
                    </div>
                  </td>
                  <td className="right mono">{i.quantity}</td>
                  <td className="right mono faint">{i.returnedQty || '—'}</td>
                  <td className="right mono">{i.outstandingQty || '—'}</td>
                  {!done && can('gchain.borrow_slips.edit_all') && (
                    <td>
                      <NumberInput
                        kind="quantity"
                        className="mono proc-cell-input"
                        step="0.001"
                        max={i.outstandingQty}
                        aria-label="Quantity returning now"
                        value={returns[i.id] ?? ''}
                        onChange={(e) => setReturns({ ...returns, [i.id]: e.target.value })}
                      />
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* The card's own act, at its foot under the quantities it takes. */}
        {!done && can('gchain.borrow_slips.edit_all') && (
          <div className="proc-row-actions proc-card-note">
            <button className="btn btn-sm btn-primary" onClick={receiveBack}>
              Receive back into stock
            </button>
          </div>
        )}
      </div>

      {modifying && (
        <BorrowModal
          existing={{
            id: String(slip.id),
            number: String(slip.number),
            borrowerName: String(slip.borrowerName),
            dueAt: String(slip.dueAt),
            purpose: String(slip.purpose),
            notes,
          }}
          onClose={() => setModifying(false)}
          onCreated={() => {
            setModifying(false);
            void load();
          }}
        />
      )}
    </div>
  );
}

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
  item: {
    id: string;
    code: string;
    name: string;
    unit: string;
    minStock: number | null;
    reorderLevel: number | null;
    category: { name: string } | null;
  };
  warehouse: { id: string; name: string };
}

export function Inventory() {
  const navigate = useNavigate();
  const [warehouses, setWarehouses] = useState<{ id: string; name: string }[]>([]);

  useEffect(() => {
    api.get<typeof warehouses>('/warehouses').then(setWarehouses).catch(() => {});
  }, []);

  const columns: Column<StockRow>[] = [
    {
      key: 'item',
      label: 'Item',
      render: (s) => (
        <div>
          <div>{s.item.name}</div>
          <div className="faint mono">{s.item.code}</div>
        </div>
      ),
    },
    { key: 'category', label: 'Category', render: (s) => s.item.category?.name ?? '—', optional: true },
    { key: 'warehouse', label: 'Warehouse', render: (s) => s.warehouse.name },
    {
      key: 'quantity',
      label: 'On hand',
      align: 'right',
      render: (s) => (
        <span className="mono">
          {s.quantity} {s.item.unit}
        </span>
      ),
    },
    {
      key: 'borrowed',
      label: 'On loan',
      align: 'right',
      render: (s) => (s.borrowedQty ? <span className="mono warn">{s.borrowedQty}</span> : <span className="faint">—</span>),
    },
    {
      key: 'available',
      label: 'Available',
      align: 'right',
      render: (s) => (
        <span className={`mono${s.needsReorder ? ' proc-short' : ''}`}>{s.available}</span>
      ),
    },
    {
      key: 'reorder',
      label: 'Reorder at',
      align: 'right',
      render: (s) => (s.item.reorderLevel ?? <span className="faint">—</span>),
      optional: true,
    },
    {
      key: 'averageCost',
      label: 'Avg. cost',
      align: 'right',
      render: (s) => <span className="mono">{formatMoney(s.averageCost)}</span>,
    },
    { key: 'value', label: 'Value', align: 'right', render: (s) => <span className="mono">{formatMoney(s.value)}</span> },
    {
      key: 'flag',
      label: '',
      render: (s) => (s.needsReorder ? <span className="badge warn">reorder</span> : null),
    },
  ];

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Inventory</h1>
        </div>
      </div>

      <DataList<StockRow>
        listKey="inventory"
        endpoint="/inventory"
        printPath="/api/inventory/pdf"
        columns={columns}
        rowKey={(s) => s.id}
        searchPlaceholder="Search item name, code, part number…"
        onRowClick={(s) => navigate(`/g-chain/inventory/${s.item.id}?warehouseId=${s.warehouse.id}`)}
        emptyTitle="No stock yet"
        emptyHint="Stock appears once goods are received into a warehouse."
        filters={[
          {
            key: 'warehouseId',
            label: 'Warehouse',
            options: warehouses.map((w) => ({ value: w.id, label: w.name })),
          },
          { key: 'needsReorder', label: 'Reorder', options: [{ value: 'true', label: 'Below level' }] },
        ]}
      />
    </div>
  );
}

export function StockCard() {
  const { itemId } = useParams<{ itemId: string }>();
  const [params] = useSearchParams();
  const warehouseId = params.get('warehouseId');
  const [data, setData] = useState<Record<string, unknown> | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    if (!itemId) return;
    api
      .get<Record<string, unknown>>(`/inventory/${itemId}/card${qs({ warehouseId })}`)
      .then(setData)
      .catch(setError)
      .finally(() => setLoading(false));
  }, [itemId, warehouseId]);

  if (loading) return <Loading />;
  if (!data) return <ErrorBox error={error ?? new Error('Not found')} />;

  const item = data.item as { code: string; name: string; unit: string; reorderLevel: number | null };
  const balances = data.balances as {
    id: string;
    quantity: number;
    borrowedQty: number;
    averageCost: number;
    value: number;
    warehouse: { name: string };
  }[];
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
          warehouseId ? (
            <>
              One warehouse only · <Link to={`/g-chain/inventory/${itemId}`}>Show every warehouse</Link>
            </>
          ) : (
            'Every warehouse'
          )
        }
      />

      <ErrorBox error={error} />

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
            sub={`${formatMoney(b.averageCost)} average · ${formatMoney(b.value)} value${
              b.borrowedQty > 0 ? ` · ${b.borrowedQty} on loan` : ''
            }`}
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

export function ChainReports() {
  const [data, setData] = useState<{
    warehouses: { id: string; name: string; items: number; value: number }[];
    totalValue: number;
    reorder: {
      itemId: string;
      warehouseId: string;
      item: string;
      code: string;
      warehouse: string;
      available: number;
      reorderLevel: number;
    }[];
    overdueBorrows: number;
  } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    api
      .get<NonNullable<typeof data>>('/inventory/reports/summary')
      .then(setData)
      .catch(setError)
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <Loading />;
  if (!data) return <ErrorBox error={error} />;

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Supply Chain Reports</h1>
          <p>Stock valuation, what needs reordering, and what is overdue back.</p>
        </div>
      </div>

      <div className="kpi-grid proc-stats">
        <Stat
          label="Stock value"
          value={formatMoney(data.totalValue)}
          sub="on hand, at moving average cost"
          accent="neon"
          figure
          more="Open inventory"
          to="/g-chain/inventory"
        />
        <Stat
          label="Below reorder level"
          value={data.reorder.length}
          sub={data.reorder.length ? 'listed below' : 'everything above its level'}
          accent={data.reorder.length ? 'warn' : 'quiet'}
          more="Open reorder list"
          to="/g-chain/inventory?needsReorder=true"
        />
        <Stat
          label="Overdue borrow slips"
          value={data.overdueBorrows}
          sub={data.overdueBorrows ? 'tools out past their return date' : 'everything back on time'}
          accent={data.overdueBorrows ? 'danger' : 'quiet'}
          more="Open overdue slips"
          to="/g-chain/borrow-slips?overdue=true"
        />
      </div>

      <div className="grid grid-2">
        <div className="card">
          <h3 className="card-title">Stock by warehouse</h3>
          {data.warehouses.length === 0 ? (
            <Empty title="No stock" />
          ) : (
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    <th>Warehouse</th>
                    <th className="right">Item lines</th>
                    <th className="right">Value</th>
                  </tr>
                </thead>
                <tbody>
                  {data.warehouses.map((w) => (
                    <tr key={w.id}>
                      <td>{w.name}</td>
                      <td className="right mono">{w.items}</td>
                      <td className="right mono">{formatMoney(w.value)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <div className="card">
          <h3 className="card-title">Needs reordering</h3>
          {data.reorder.length === 0 ? (
            <Empty title="Everything is above its reorder level" />
          ) : (
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    <th>Item</th>
                    <th>Warehouse</th>
                    <th className="right">Available</th>
                    <th className="right">Reorder at</th>
                  </tr>
                </thead>
                <tbody>
                  {data.reorder.map((r) => (
                    <tr key={`${r.itemId}-${r.warehouseId}`}>
                      <td>
                        {/* The stock card for that item in that store — where
                            the reorder decision is actually made. */}
                        <Link to={`/g-chain/inventory/${r.itemId}?warehouseId=${r.warehouseId}`}>{r.item}</Link>
                        <div className="faint mono">{r.code}</div>
                      </td>
                      <td>{r.warehouse}</td>
                      <td className="right mono proc-short">{r.available}</td>
                      <td className="right mono faint">{r.reorderLevel}</td>
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
