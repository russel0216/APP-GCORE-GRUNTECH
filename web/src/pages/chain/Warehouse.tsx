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
  StatusBadge,
  formatDate,
  formatDateTime,
  formatMoney,
  useToast,
} from '../../components/ui';
import { Stat } from '../../components/charts';
import { openPdf } from '../../lib/api';
import { label } from './PurchaseRequests';

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
          <p>
            Where a direct-to-job purchase stops being a promise and becomes a cost. Stock
            replenishment lands in the warehouse instead, and charges a project only when issued.
          </p>
        </div>
      </div>

      <DataList<ReceivingRow>
        listKey="receivings"
        endpoint="/receivings"
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
  const [rec, setRec] = useState<Record<string, unknown> | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    if (!id) return;
    api
      .get<Record<string, unknown>>(`/receivings/${id}`)
      .then(setRec)
      .catch(setError)
      .finally(() => setLoading(false));
  }, [id]);

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

  return (
    <div>
      <div className="breadcrumb">
        {order.job && (
          <>
            <Link to={`/g-ops/projects/${order.job.id}`}>{order.job.number}</Link>
            <span className="sep">›</span>
          </>
        )}
        <Link to={`/g-chain/purchase-orders/${order.id}`}>{order.number}</Link>
        <span className="sep">›</span>
        <Link to="/g-chain/receiving">Receiving</Link>
        <span className="sep">›</span>
        <span className="mono">{String(rec.number)}</span>
      </div>

      <div className="page-head">
        <div>
          <h1>Receiving {String(rec.number)}</h1>
          <p>
            <Link to={`/g-chain/suppliers/${order.supplier.id}`}>{order.supplier.name}</Link> ·{' '}
            {formatDate(String(rec.receivedDate))}
            {(rec.warehouse as { name: string } | null) ? ` · into ${(rec.warehouse as { name: string }).name}` : ''}
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
          </p>
        </div>
        {canEnterBill && (
          <div className="row">
            {/* The bill picks up the supplier, order and these goods from the
                receiving, and — because it names the receiving — posts no job
                cost a second time. */}
            <Link to={`/g-fin/ap?fromReceiving=${String(rec.id)}`} className="btn btn-primary">
              Enter supplier bill
            </Link>
          </div>
        )}
      </div>

      <ErrorBox error={error} />

      <div className={`alert ${order.kind === 'DIRECT_TO_JOB' ? 'ok' : 'info'}`}>
        {order.kind === 'DIRECT_TO_JOB'
          ? `${formatMoney(Number(rec.value))} charged to ${order.job?.number ?? 'the project'}, and the same released from committed.`
          : `${formatMoney(Number(rec.value))} added to stock. No project has been charged — that happens at issuance.`}
      </div>

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
    </div>
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
          <p>
            Material leaving the store for a project. This is where stock-sourced material first
            charges a job, valued at the moving average cost — which is why it cannot also have been
            charged at receiving.
          </p>
        </div>
      </div>

      <DataList<IssueRow>
        listKey="stock-issues"
        endpoint="/stock-issues"
        columns={columns}
        rowKey={(i) => i.id}
        searchPlaceholder="Search number, purpose, project…"
        reloadToken={reload}
        onRowClick={(i) => navigate(`/g-chain/stock-issuance/${i.id}`)}
        emptyTitle="Nothing issued yet"
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
              + New issue
            </button>
          ) : null
        }
      />

      {creating && (
        <NewIssueModal
          onClose={() => setCreating(false)}
          onCreated={(id) => {
            setCreating(false);
            setReload((r) => r + 1);
            navigate(`/g-chain/stock-issuance/${id}`);
          }}
        />
      )}
    </div>
  );
}

function NewIssueModal({ onClose, onCreated }: { onClose: () => void; onCreated: (id: string) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [jobs, setJobs] = useState<{ id: string; number: string; name: string }[]>([]);
  const [warehouses, setWarehouses] = useState<{ id: string; name: string }[]>([]);
  const [form, setForm] = useState({ jobId: '', warehouseId: '', issuedToName: '', purpose: '' });

  useEffect(() => {
    api.get<typeof jobs>('/jobs/lookup').then(setJobs).catch(() => {});
    api
      .get<typeof warehouses>('/warehouses')
      .then((w) => {
        setWarehouses(w);
        if (w.length === 1) setForm((f) => ({ ...f, warehouseId: w[0].id }));
      })
      .catch(() => {});
  }, []);

  async function create() {
    setBusy(true);
    setError(null);
    try {
      const created = await api.post<{ id: string }>('/stock-issues', {
        jobId: form.jobId || null,
        warehouseId: form.warehouseId,
        issuedToName: form.issuedToName || null,
        purpose: form.purpose,
      });
      onCreated(created.id);
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  }

  return (
    <Modal
      title="New stock issue"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button
            className="btn btn-primary"
            onClick={create}
            disabled={busy || !form.warehouseId || form.purpose.length < 3}
          >
            {busy ? 'Creating…' : 'Create'}
          </button>
        </>
      }
    >
      <ErrorBox error={error} />
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
      <Field label="For project" hint="Leave blank for general use — no job is charged">
        <select value={form.jobId} onChange={(e) => setForm({ ...form, jobId: e.target.value })}>
          <option value="">— none —</option>
          {jobs.map((j) => (
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
    </Modal>
  );
}

export function StockIssueDetail() {
  const { id } = useParams<{ id: string }>();
  const toast = useToast();
  const [issue, setIssue] = useState<Record<string, unknown> | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [adding, setAdding] = useState(false);

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

  async function commit() {
    try {
      setIssue(await api.post<Record<string, unknown>>(`/stock-issues/${id}/issue`));
      toast('ok', job ? 'Issued — the project has been charged' : 'Issued');
      await load();
    } catch (err) {
      setError(err);
    }
  }

  return (
    <div>
      <div className="breadcrumb">
        {job && (
          <>
            <Link to={`/g-ops/projects/${job.id}`}>{job.number}</Link>
            <span className="sep">›</span>
          </>
        )}
        <Link to="/g-chain/stock-issuance">Stock Issuance</Link>
        <span className="sep">›</span>
        <span className="mono">{String(issue.number)}</span>
      </div>

      <div className="page-head">
        <div>
          <h1>{String(issue.purpose)}</h1>
          <p>
            {warehouse.name}
            {job ? ` → ${job.number}` : ''} · {formatDate(String(issue.issueDate))}
            <span className="proc-pill-gap">
              <StatusBadge status={String(issue.status)} />
            </span>
          </p>
        </div>
        <div className="row">
          <button
            className="btn"
            onClick={() => openPdf(`/api/stock-issues/${id}/pdf`, () => toast('error', 'Could not print'))}
          >
            Print
          </button>
          {isDraft && (
            <>
              <button className="btn btn-primary" onClick={() => setAdding(true)}>
                + Add item
              </button>
              <button className="btn btn-ok" disabled={items.length === 0} onClick={commit}>
                Issue
              </button>
            </>
          )}
        </div>
      </div>

      <ErrorBox error={error} />

      {isDraft && job && (
        <div className="alert info">
          Nothing has moved yet. Issuing will take the stock out and charge{' '}
          {formatMoney(Number(issue.value))} to {job.number} at the current average cost.
        </div>
      )}

      <div className="card">
        <h3 className="card-title">Items</h3>
        {items.length === 0 ? (
          <Empty title="No items yet" />
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
                  {isDraft && <th className="proc-col-actions" aria-label="Actions" />}
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
                    {isDraft && (
                      <td>
                        <button
                          className="btn btn-ghost btn-sm"
                          onClick={async () => {
                            await api.del(`/stock-issues/${id}/items/${i.id}`);
                            await load();
                          }}
                        >
                          ✕
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
                    <strong>{formatMoney(Number(issue.value))}</strong>
                  </td>
                  {isDraft && <td />}
                </tr>
              </tbody>
            </table>
          </div>
        )}
      </div>

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
      title="Add an item to issue"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button
            className="btn btn-primary"
            onClick={save}
            disabled={busy || !form.itemId || Number(form.quantity) <= 0}
          >
            {busy ? 'Adding…' : 'Add'}
          </button>
        </>
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
        <input
          type="number"
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
          <p>
            Tools and equipment lent out and expected back. A borrow slip does{' '}
            <strong>not</strong> charge job cost — the asset is on loan, not consumed. It comes out
            of what the warehouse can issue until it is returned.
          </p>
        </div>
      </div>

      <DataList<BorrowRow>
        listKey="borrow-slips"
        endpoint="/borrow-slips"
        columns={columns}
        rowKey={(b) => b.id}
        searchPlaceholder="Search number, borrower, purpose…"
        reloadToken={reload}
        onRowClick={(b) => navigate(`/g-chain/borrow-slips/${b.id}`)}
        emptyTitle="Nothing on loan"
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
              + Lend out
            </button>
          ) : null
        }
      />

      {creating && (
        <NewBorrowModal
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

function NewBorrowModal({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
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
      title="Lend tools out"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button
            className="btn btn-primary"
            onClick={create}
            disabled={busy || !form.warehouseId || !form.borrowerName || !form.dueAt || !valid}
          >
            {busy ? 'Saving…' : 'Lend out'}
          </button>
        </>
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
          <input
            type="number"
            step="0.001"
            className="proc-qty"
            aria-label={`Quantity of item ${i + 1}`}
            value={l.quantity}
            onChange={(e) => setLines(lines.map((x, n) => (n === i ? { ...x, quantity: e.target.value } : x)))}
          />
          <button
            className="btn btn-ghost btn-sm"
            onClick={() => setLines(lines.filter((_, n) => n !== i))}
            disabled={lines.length === 1}
          >
            ✕
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
      <div className="breadcrumb">
        <Link to="/g-chain/borrow-slips">Borrow Slips</Link>
        <span className="sep">›</span>
        <span className="mono">{String(slip.number)}</span>
      </div>

      <div className="page-head">
        <div>
          <h1>{String(slip.borrowerName)}</h1>
          <p>
            {String(slip.purpose)}
            {job ? ` · ${job.number}` : ''} · due {formatDate(String(slip.dueAt))}
            <span className="proc-pill-gap">
              <StatusBadge status={String(slip.status)} extra={{ RETURNED: 'ok' }} />
            </span>
          </p>
        </div>
      </div>

      <ErrorBox error={error} />

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
                      <input
                        className="mono proc-cell-input"
                        type="number"
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

        {!done && can('gchain.borrow_slips.edit_all') && (
          <div className="row proc-card-note">
            <button className="btn btn-ok" onClick={receiveBack}>
              Receive back into stock
            </button>
          </div>
        )}
      </div>
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
          <p>
            Stock valued at moving weighted average — a receipt changes the average, an issue takes
            it as given. Items on loan are still owned but cannot be issued.
          </p>
        </div>
      </div>

      <DataList<StockRow>
        listKey="inventory"
        endpoint="/inventory"
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
      <div className="breadcrumb">
        <Link to="/g-chain/inventory">Inventory</Link>
        <span className="sep">›</span>
        <span className="mono">{item.code}</span>
      </div>

      <div className="page-head">
        <div>
          <h1>{item.name}</h1>
          <p>
            <span className="mono">{item.code}</span> · stock card
          </p>
        </div>
      </div>

      <ErrorBox error={error} />

      {warehouseId && (
        <p className="muted">
          One warehouse only. <Link to={`/g-chain/inventory/${itemId}`}>Show every warehouse</Link>
        </p>
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
