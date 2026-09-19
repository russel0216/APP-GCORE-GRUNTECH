import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { DataList, type Column } from '../../components/DataList';
import {
  Checkbox,
  ErrorBox,
  Field,
  Loading,
  Modal,
  formatDate,
  formatMoney,
  useToast,
} from '../../components/ui';
import { RecordPaymentModal, tone, label } from './Receivables';
import { todayLocal } from '../../lib/day';

/**
 * Accounts Payable — supplier bills and expense claims.
 *
 * The rule that shapes this screen: **a bill matched to a receiving posts no
 * job cost**. Receiving already incurred it when the goods arrived; posting
 * again would charge the project twice for the same peso. A bill with nothing
 * received behind it — a subcontractor's certificate, a service call — is the
 * first time that cost appears, so that one does post.
 */

const BILL_STATUSES = [
  { value: 'DRAFT', label: 'Draft' },
  { value: 'PENDING_APPROVAL', label: 'Pending approval' },
  { value: 'APPROVED', label: 'Approved' },
  { value: 'PARTIALLY_PAID', label: 'Partly paid' },
  { value: 'PAID', label: 'Paid' },
  { value: 'CANCELLED', label: 'Cancelled' },
];

interface Bill {
  id: string;
  number: string;
  status: string;
  supplierInvoiceNo: string | null;
  billDate: string;
  dueDate: string;
  terms: string | null;
  subtotal: number;
  vatRate: number;
  vatAmount: number;
  total: number;
  ewtRate: number;
  ewtAmount: number;
  netPayable: number;
  amountPaid: number;
  outstanding: number;
  daysOverdue: number;
  postedToJob: boolean;
  postedAt: string | null;
  notes: string | null;
  supplier: { id: string; code: string; name: string };
  order: { id: string; number: string; kind: string } | null;
  receiving: { id: string; number: string; receivedDate: string } | null;
  job: { id: string; number: string; name: string } | null;
  costCategory: { id: string; name: string } | null;
  lines: { id: string; description: string; quantity: number; unitPrice: number; amount: number }[];
  allocations?: {
    id: string;
    amount: number;
    payment: { id: string; number: string; paymentDate: string; method: string; reference: string | null };
  }[];
}

interface UnbilledReceiving {
  id: string;
  number: string;
  receivedDate: string;
  invoiceRefNo: string | null;
  order: {
    id: string;
    number: string;
    total: number;
    supplier: { id: string; name: string };
    job: { id: string; number: string; name: string } | null;
  };
  receivedValue: number;
  waitingDays: number;
}

export function Payables() {
  const { can } = useAuth();
  const navigate = useNavigate();
  const [queue, setQueue] = useState<UnbilledReceiving[] | null>(null);
  const [creating, setCreating] = useState<UnbilledReceiving | 'blank' | null>(null);
  const [reload, setReload] = useState(0);

  const loadQueue = useCallback(async () => {
    try {
      setQueue(await api.get<UnbilledReceiving[]>('/supplier-bills/queue/unbilled'));
    } catch {
      setQueue([]);
    }
  }, []);

  useEffect(() => {
    loadQueue();
  }, [loadQueue, reload]);

  const columns: Column<Bill>[] = [
    {
      key: 'number',
      label: 'Number',
      sortKey: 'number',
      width: '150px',
      render: (r) => (
        <div>
          <span className="mono">{r.number}</span>
          {r.supplierInvoiceNo && <div className="faint mono">{r.supplierInvoiceNo}</div>}
        </div>
      ),
    },
    {
      key: 'supplier',
      label: 'Supplier',
      render: (r) => (
        <div>
          <div>{r.supplier.name}</div>
          <div className="faint">
            {r.job ? `${r.job.number} — ${r.job.name}` : 'No project'}
            {r.receiving && ` · ${r.receiving.number}`}
          </div>
        </div>
      ),
    },
    {
      key: 'dueDate',
      label: 'Due',
      sortKey: 'dueDate',
      render: (r) => (
        <div>
          <div>{formatDate(r.dueDate)}</div>
          {r.outstanding > 0 && r.daysOverdue > 0 && (
            <div className="faint warn">{r.daysOverdue} days late</div>
          )}
        </div>
      ),
    },
    {
      key: 'total',
      label: 'Billed',
      align: 'right',
      render: (r) => <span className="mono faint">{formatMoney(r.total)}</span>,
    },
    {
      key: 'netPayable',
      label: 'Payable',
      align: 'right',
      render: (r) => (
        <div>
          <div className="mono">{formatMoney(r.netPayable)}</div>
          {r.ewtAmount > 0 && <div className="faint">less {formatMoney(r.ewtAmount)} withheld</div>}
        </div>
      ),
    },
    {
      key: 'outstanding',
      label: 'Outstanding',
      align: 'right',
      render: (r) => (
        <span className={`mono ${r.outstanding > 0 && r.daysOverdue > 0 ? 'warn' : ''}`}>
          {formatMoney(r.outstanding)}
        </span>
      ),
    },
    {
      key: 'posted',
      label: 'Job cost',
      optional: true,
      render: (r) =>
        r.postedToJob ? (
          <span className="badge ok" title="This bill was the first time that cost appeared">
            charged
          </span>
        ) : r.receiving ? (
          <span className="badge" title={`${r.receiving.number} already incurred it`}>
            already incurred
          </span>
        ) : (
          <span className="faint">—</span>
        ),
    },
    {
      key: 'status',
      label: 'Status',
      render: (r) => <span className={`badge ${tone(r.status)}`}>{label(r.status)}</span>,
    },
  ];

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Accounts Payable</h1>
          <p>
            A bill raised against a receiving does <strong>not</strong> charge the project again —
            the goods were charged when they arrived. A bill with nothing received behind it does,
            because that is the first time the cost appears.
          </p>
        </div>
        <div className="row">
          {can('gfin.ap.create') && (
            <button className="btn btn-primary btn-sm" onClick={() => setCreating('blank')}>
              + New bill
            </button>
          )}
        </div>
      </div>

      {queue && queue.length > 0 && (
        <div className="card">
          <h3 className="card-title">
            {queue.length} receiving{queue.length === 1 ? '' : 's'} with no bill yet
          </h3>
          <p className="muted">
            Goods arrived and were charged to the project. The supplier's invoice is what turns
            that into something payable.
          </p>
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Receiving</th>
                  <th>Supplier</th>
                  <th>Project</th>
                  <th className="right">Value received</th>
                  <th className="right">Waiting</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {queue.map((r) => (
                  <tr key={r.id}>
                    <td>
                      <span className="mono">{r.number}</span>
                      <div className="faint">{formatDate(r.receivedDate)}</div>
                    </td>
                    <td>{r.order.supplier.name}</td>
                    <td className="faint">
                      {r.order.job ? `${r.order.job.number} — ${r.order.job.name}` : 'Stock'}
                    </td>
                    <td className="right mono">{formatMoney(r.receivedValue)}</td>
                    <td className="right">
                      <span className={r.waitingDays > 30 ? 'warn' : 'faint'}>{r.waitingDays}d</span>
                    </td>
                    <td className="right">
                      {can('gfin.ap.create') && (
                        <button className="btn btn-sm btn-primary" onClick={() => setCreating(r)}>
                          Enter bill
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <DataList<Bill>
        listKey="supplier-bills"
        endpoint="/supplier-bills"
        columns={columns}
        rowKey={(r) => r.id}
        reloadToken={reload}
        searchPlaceholder="Search number, supplier, their invoice number…"
        emptyTitle="No supplier bills yet"
        onRowClick={(r) => navigate(`/g-fin/ap/${r.id}`)}
        filters={[
          { key: 'status', label: 'Status', options: BILL_STATUSES },
          { key: 'outstanding', label: 'Balance', options: [{ value: 'true', label: 'Outstanding only' }] },
          { key: 'overdue', label: 'Overdue', options: [{ value: 'true', label: 'Overdue only' }] },
        ]}
      />

      {creating && (
        <NewBillModal
          from={creating === 'blank' ? null : creating}
          onClose={() => setCreating(null)}
          onCreated={(id) => {
            setCreating(null);
            setReload((r) => r + 1);
            navigate(`/g-fin/ap/${id}`);
          }}
        />
      )}
    </div>
  );
}

function NewBillModal({
  from,
  onClose,
  onCreated,
}: {
  from: UnbilledReceiving | null;
  onClose: () => void;
  onCreated: (id: string) => void;
}) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [suppliers, setSuppliers] = useState<{ id: string; name: string }[]>([]);
  const [jobs, setJobs] = useState<{ id: string; number: string; name: string }[]>([]);
  const [categories, setCategories] = useState<{ id: string; name: string }[]>([]);
  const [settings, setSettings] = useState<{
    defaultTermsDays: number;
    supplierEwtGoods: number;
    supplierEwtServices: number;
    vatRate: number;
  } | null>(null);

  const today = todayLocal();
  const [form, setForm] = useState({
    supplierId: from?.order.supplier.id ?? '',
    jobId: from?.order.job?.id ?? '',
    costCategoryId: '',
    supplierInvoiceNo: from?.invoiceRefNo ?? '',
    billDate: today,
    terms: 30,
    vatInclusive: false,
    ewtRate: 0,
    notes: '',
  });
  const [lines, setLines] = useState([
    {
      description: from ? `Goods received on ${from.number}` : '',
      quantity: 1,
      unitPrice: from?.receivedValue ?? 0,
    },
  ]);

  useEffect(() => {
    api.get<{ rows: { id: string; name: string }[] }>('/suppliers?pageSize=200').then((d) => setSuppliers(d.rows)).catch(() => {});
    api.get<typeof jobs>('/jobs/lookup').then(setJobs).catch(() => {});
    api.get<{ id: string; name: string }[]>('/reference/cost-categories').then(setCategories).catch(() => {});
    api
      .get<{ defaultTermsDays: number; supplierEwtGoods: number; supplierEwtServices: number; vatRate: number }>(
        '/finance-settings',
      )
      .then((s) => {
        setSettings(s);
        setForm((f) => ({ ...f, terms: s.defaultTermsDays }));
      })
      .catch(() => {});
  }, []);

  const vatRate = settings?.vatRate ?? 0.12;
  const lineTotal = lines.reduce((s, l) => s + l.quantity * l.unitPrice, 0);
  const subtotal = form.vatInclusive ? lineTotal / (1 + vatRate) : lineTotal;
  const vatAmount = subtotal * vatRate;
  const total = subtotal + vatAmount;
  const ewtAmount = subtotal * form.ewtRate;
  const netPayable = total - ewtAmount;

  const dueDate = (() => {
    const d = new Date(`${form.billDate}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + form.terms);
    return d.toISOString().slice(0, 10);
  })();

  async function create() {
    setBusy(true);
    setError(null);
    try {
      const created = await api.post<{ id: string }>('/supplier-bills', {
        supplierId: form.supplierId,
        orderId: from?.order.id ?? null,
        receivingId: from?.id ?? null,
        jobId: form.jobId || null,
        costCategoryId: form.costCategoryId || null,
        supplierInvoiceNo: form.supplierInvoiceNo || null,
        billDate: form.billDate,
        dueDate,
        terms: `${form.terms} days`,
        vatInclusive: form.vatInclusive,
        ewtRate: form.ewtRate,
        notes: form.notes || null,
        lines: lines.filter((l) => l.description.trim() && l.unitPrice !== 0),
      });
      toast('ok', 'Bill entered — submit it for approval next');
      onCreated(created.id);
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  }

  return (
    <Modal
      title={from ? `Bill for ${from.number}` : 'New supplier bill'}
      onClose={onClose}
      wide
      footer={
        <>
          <button className="btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button
            className="btn btn-primary"
            onClick={create}
            disabled={busy || !form.supplierId || lineTotal <= 0}
          >
            {busy ? 'Saving…' : 'Enter bill'}
          </button>
        </>
      }
    >
      <ErrorBox error={error} />

      {from ? (
        <div className="alert info">
          This bill is matched to <span className="mono">{from.number}</span>. The goods were
          already charged to the project when they arrived, so approving this bill makes it
          payable and charges nothing further.
        </div>
      ) : (
        <div className="alert warn">
          A bill with no receiving behind it — a subcontractor's certificate, a service call —
          <strong> is</strong> charged to the project it names when approved. Leave the project
          empty if it belongs to overheads.
        </div>
      )}

      <div className="grid grid-2">
        <Field label="Supplier">
          <select
            value={form.supplierId}
            onChange={(e) => setForm({ ...form, supplierId: e.target.value })}
            disabled={!!from}
          >
            <option value="">— choose —</option>
            {suppliers.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Their invoice number">
          <input
            value={form.supplierInvoiceNo}
            onChange={(e) => setForm({ ...form, supplierInvoiceNo: e.target.value })}
          />
        </Field>
      </div>

      <div className="grid grid-2">
        <Field label="Bill date">
          <input
            type="date"
            value={form.billDate}
            onChange={(e) => setForm({ ...form, billDate: e.target.value })}
          />
        </Field>
        <Field label="Terms (days)" hint={`Due ${formatDate(dueDate)}`}>
          <input
            type="number"
            min={0}
            max={365}
            value={form.terms}
            onChange={(e) => setForm({ ...form, terms: Number(e.target.value) })}
          />
        </Field>
      </div>

      <div className="grid grid-2">
        <Field label="Project" hint={from ? 'Carried from the order' : 'Leave empty for overheads'}>
          <select value={form.jobId} onChange={(e) => setForm({ ...form, jobId: e.target.value })}>
            <option value="">— none —</option>
            {jobs.map((j) => (
              <option key={j.id} value={j.id}>
                {j.number} — {j.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Budget line">
          <select
            value={form.costCategoryId}
            onChange={(e) => setForm({ ...form, costCategoryId: e.target.value })}
          >
            <option value="">— none —</option>
            {categories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </Field>
      </div>

      <h4 style={{ marginTop: 18, marginBottom: 8 }}>Lines</h4>
      <div className="table-wrap">
        <table className="data">
          <thead>
            <tr>
              <th>Description</th>
              <th className="right" style={{ width: 90 }}>
                Qty
              </th>
              <th className="right" style={{ width: 140 }}>
                Unit price
              </th>
              <th className="right" style={{ width: 120 }}>
                Amount
              </th>
              <th style={{ width: 40 }} />
            </tr>
          </thead>
          <tbody>
            {lines.map((l, i) => (
              <tr key={i}>
                <td>
                  <input
                    value={l.description}
                    onChange={(e) => {
                      const next = [...lines];
                      next[i] = { ...l, description: e.target.value };
                      setLines(next);
                    }}
                  />
                </td>
                <td>
                  <input
                    type="number"
                    step="0.01"
                    value={l.quantity}
                    onChange={(e) => {
                      const next = [...lines];
                      next[i] = { ...l, quantity: Number(e.target.value) };
                      setLines(next);
                    }}
                    style={{ textAlign: 'right' }}
                  />
                </td>
                <td>
                  <input
                    type="number"
                    step="0.01"
                    value={l.unitPrice}
                    onChange={(e) => {
                      const next = [...lines];
                      next[i] = { ...l, unitPrice: Number(e.target.value) };
                      setLines(next);
                    }}
                    style={{ textAlign: 'right' }}
                  />
                </td>
                <td className="right mono">{formatMoney(l.quantity * l.unitPrice)}</td>
                <td className="right">
                  {lines.length > 1 && (
                    <button
                      className="btn btn-ghost btn-sm"
                      onClick={() => setLines(lines.filter((_, j) => j !== i))}
                    >
                      ✕
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <button
        className="btn btn-sm"
        style={{ marginTop: 8 }}
        onClick={() => setLines([...lines, { description: '', quantity: 1, unitPrice: 0 }])}
      >
        + Add a line
      </button>

      <div className="grid grid-2" style={{ marginTop: 16 }}>
        <div>
          <Checkbox
            checked={form.vatInclusive}
            onChange={(v) => setForm({ ...form, vatInclusive: v })}
            label="Their prices already include VAT"
          />
          <Field
            label="Withhold from this supplier"
            hint="Withheld on the subtotal, never on the VAT. Zero unless you are sure."
          >
            <select
              value={form.ewtRate}
              onChange={(e) => setForm({ ...form, ewtRate: Number(e.target.value) })}
            >
              <option value={0}>None</option>
              <option value={settings?.supplierEwtGoods ?? 0.01}>
                Goods — {((settings?.supplierEwtGoods ?? 0.01) * 100).toFixed(0)}%
              </option>
              <option value={settings?.supplierEwtServices ?? 0.02}>
                Services / subcontract — {((settings?.supplierEwtServices ?? 0.02) * 100).toFixed(0)}%
              </option>
            </select>
          </Field>
        </div>

        <dl className="kv">
          <dt>Subtotal</dt>
          <dd className="mono">{formatMoney(subtotal)}</dd>
          <dt>VAT {(vatRate * 100).toFixed(0)}%</dt>
          <dd className="mono">{formatMoney(vatAmount)}</dd>
          <dt>
            <strong>Total</strong>
          </dt>
          <dd className="mono">
            <strong>{formatMoney(total)}</strong>
          </dd>
          <dt>Less: withheld</dt>
          <dd className="mono">({formatMoney(ewtAmount)})</dd>
          <dt>
            <strong>Net payable</strong>
          </dt>
          <dd className="mono">
            <strong>{formatMoney(netPayable)}</strong>
          </dd>
        </dl>
      </div>
    </Modal>
  );
}

// ── One bill ─────────────────────────────────────────────────────────────────

export function BillDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const toast = useToast();
  const { can } = useAuth();
  const [row, setRow] = useState<Bill | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [paying, setPaying] = useState(false);

  const load = useCallback(async () => {
    try {
      setRow(await api.get<Bill>(`/supplier-bills/${id}`));
    } catch (err) {
      setError(err);
    }
  }, [id]);

  useEffect(() => {
    load();
  }, [load]);

  if (error) return <ErrorBox error={error} />;
  if (!row) return <Loading />;

  async function submit() {
    try {
      await api.post(`/supplier-bills/${id}/submit`);
      toast('ok', 'Sent for approval');
      load();
    } catch (err) {
      setError(err);
    }
  }

  return (
    <div>
      <div className="breadcrumb">
        <button className="btn btn-ghost btn-sm" onClick={() => navigate('/g-fin/ap')}>
          ← Payables
        </button>
      </div>

      <div className="page-head">
        <div>
          <h1>
            <span className="mono">{row.number}</span>{' '}
            <span className={`badge ${tone(row.status)}`}>{label(row.status)}</span>
          </h1>
          <p>
            {row.supplier.name}
            {row.supplierInvoiceNo && <> · their ref {row.supplierInvoiceNo}</>}
            {row.job && (
              <>
                {' · '}
                <Link to={`/g-ops/projects/${row.job.id}`} className="mono">
                  {row.job.number}
                </Link>
              </>
            )}
          </p>
        </div>
        <div className="row">
          {row.status === 'DRAFT' && can('gfin.ap.create') && (
            <button className="btn btn-primary btn-sm" onClick={submit}>
              Submit for approval
            </button>
          )}
          {(row.status === 'APPROVED' || row.status === 'PARTIALLY_PAID') && can('gfin.ap.create') && (
            <button className="btn btn-primary btn-sm" onClick={() => setPaying(true)}>
              Record payment
            </button>
          )}
        </div>
      </div>

      {row.receiving ? (
        <div className="alert info">
          Matched to <span className="mono">{row.receiving.number}</span>, received{' '}
          {formatDate(row.receiving.receivedDate)}. The project was charged then — approving this
          bill makes it payable and charges nothing further.
        </div>
      ) : row.postedToJob ? (
        <div className="alert ok">
          Nothing was received against this bill, so it was the first time this cost appeared:{' '}
          {formatMoney(row.subtotal)} was charged to {row.job?.number} on{' '}
          {row.postedAt ? formatDate(row.postedAt) : 'approval'}.
        </div>
      ) : row.status === 'APPROVED' ? (
        <div className="alert warn">
          No project or budget line was set, so nothing was charged to a job. This is payable, but
          it does not appear in any project's cost.
        </div>
      ) : null}

      <div className="grid grid-2">
        <div className="card">
          <h3 className="card-title">What was billed</h3>
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Description</th>
                  <th className="right">Qty</th>
                  <th className="right">Unit</th>
                  <th className="right">Amount</th>
                </tr>
              </thead>
              <tbody>
                {row.lines.map((l) => (
                  <tr key={l.id}>
                    <td>{l.description}</td>
                    <td className="right mono">{l.quantity}</td>
                    <td className="right mono">{formatMoney(l.unitPrice)}</td>
                    <td className="right mono">{formatMoney(l.amount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <dl className="kv" style={{ marginTop: 14 }}>
            <dt>Subtotal</dt>
            <dd className="mono">{formatMoney(row.subtotal)}</dd>
            <dt>VAT {(row.vatRate * 100).toFixed(0)}%</dt>
            <dd className="mono">{formatMoney(row.vatAmount)}</dd>
            <dt>
              <strong>Total</strong>
            </dt>
            <dd className="mono">
              <strong>{formatMoney(row.total)}</strong>
            </dd>
            {row.ewtAmount > 0 && (
              <>
                <dt>Less: withheld {(row.ewtRate * 100).toFixed(0)}%</dt>
                <dd className="mono">({formatMoney(row.ewtAmount)})</dd>
              </>
            )}
            <dt>
              <strong>Net payable</strong>
            </dt>
            <dd className="mono">
              <strong>{formatMoney(row.netPayable)}</strong>
            </dd>
          </dl>
        </div>

        <div>
          <div className="card">
            <h3 className="card-title">Where it stands</h3>
            <dl className="kv">
              <dt>Bill date</dt>
              <dd>{formatDate(row.billDate)}</dd>
              <dt>Due</dt>
              <dd>
                {formatDate(row.dueDate)}
                {row.outstanding > 0 && row.daysOverdue > 0 && (
                  <span className="warn"> · {row.daysOverdue} days late</span>
                )}
              </dd>
              <dt>Order</dt>
              <dd>
                {row.order ? (
                  <Link to={`/g-chain/purchase-orders/${row.order.id}`} className="mono">
                    {row.order.number}
                  </Link>
                ) : (
                  <span className="faint">none</span>
                )}
              </dd>
              <dt>Budget line</dt>
              <dd>{row.costCategory?.name ?? <span className="faint">none</span>}</dd>
              <dt>Paid</dt>
              <dd className="mono">{formatMoney(row.amountPaid)}</dd>
              <dt>Outstanding</dt>
              <dd className="mono">
                <strong>{formatMoney(row.outstanding)}</strong>
              </dd>
            </dl>
          </div>

          <div className="card">
            <h3 className="card-title">Payments</h3>
            {!row.allocations?.length ? (
              <p className="muted" style={{ marginBottom: 0 }}>
                Nothing paid yet.
              </p>
            ) : (
              <div className="table-wrap">
                <table className="data">
                  <tbody>
                    {row.allocations.map((a) => (
                      <tr key={a.id}>
                        <td>
                          <span className="mono">{a.payment.number}</span>
                          <div className="faint">
                            {formatDate(a.payment.paymentDate)} ·{' '}
                            {a.payment.method.toLowerCase().replace(/_/g, ' ')}
                          </div>
                        </td>
                        <td className="right mono">{formatMoney(a.amount)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      </div>

      {paying && (
        <RecordPaymentModal
          kind="DISBURSEMENT"
          party={{ id: row.supplier.id, name: row.supplier.name }}
          target={{ kind: 'bill', id: row.id, number: row.number, outstanding: row.outstanding }}
          onClose={() => setPaying(false)}
          onSaved={() => {
            setPaying(false);
            load();
          }}
        />
      )}
    </div>
  );
}
