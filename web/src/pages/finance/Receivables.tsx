import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { DataList, type Column } from '../../components/DataList';
import {
  ErrorBox,
  Field,
  Loading,
  Modal,
  formatDate,
  formatMoney,
  useToast,
} from '../../components/ui';

/**
 * Accounts Receivable.
 *
 * The number on every screen here is **outstanding against net collectible**,
 * not against the invoice total. EWT is withheld by the customer at source and
 * comes back as a BIR 2307 certificate rather than as cash, so an invoice paid
 * in full still shows a gap against its printed total — and treating that gap
 * as a debt makes every customer look like a late payer (model §5.4).
 */

export const INVOICE_STATUSES = [
  { value: 'DRAFT', label: 'Draft' },
  { value: 'ISSUED', label: 'Issued' },
  { value: 'PARTIALLY_PAID', label: 'Partly paid' },
  { value: 'PAID', label: 'Paid' },
  { value: 'CANCELLED', label: 'Cancelled' },
];

export function tone(status: string) {
  if (status === 'PAID' || status === 'APPROVED' || status === 'REIMBURSED') return 'ok';
  if (status === 'CANCELLED' || status === 'REJECTED') return 'danger';
  if (status === 'DRAFT') return '';
  return 'warn';
}

export const label = (s: string) => s.toLowerCase().replace(/_/g, ' ');

export interface Invoice {
  id: string;
  number: string;
  status: string;
  invoiceDate: string;
  dueDate: string;
  terms: string | null;
  poReference: string | null;
  grossAmount: number;
  vatRate: number;
  vatAmount: number;
  ewtRate: number;
  ewtAmount: number;
  invoiceTotal: number;
  netCollectible: number;
  amountCollected: number;
  outstanding: number;
  daysOverdue: number;
  ewtCertificateNo: string | null;
  ewtCertificateAt: string | null;
  notes: string | null;
  customer: { id: string; code: string; name: string };
  job: { id: string; number: string; name: string } | null;
  progressBilling: { id: string; number: string; billingNo: number } | null;
  lines: { id: string; description: string; detail: string | null; amount: number }[];
  allocations?: {
    id: string;
    amount: number;
    payment: {
      id: string;
      number: string;
      paymentDate: string;
      method: string;
      reference: string | null;
      clearedAt: string | null;
    };
  }[];
}

interface UninvoicedBilling {
  id: string;
  number: string;
  billingNo: number;
  billingDate: string;
  job: { id: string; number: string; name: string; customer: { id: string; name: string } };
  grossAmount: number;
  invoiceTotal: number;
  netCollectible: number;
  waitingDays: number;
}

export function Receivables() {
  const { can } = useAuth();
  const navigate = useNavigate();
  const [queue, setQueue] = useState<UninvoicedBilling[] | null>(null);
  const [raising, setRaising] = useState<UninvoicedBilling | null>(null);
  const [reload, setReload] = useState(0);

  const loadQueue = useCallback(async () => {
    try {
      setQueue(await api.get<UninvoicedBilling[]>('/invoices/queue/uninvoiced'));
    } catch {
      setQueue([]);
    }
  }, []);

  useEffect(() => {
    loadQueue();
  }, [loadQueue, reload]);

  const columns: Column<Invoice>[] = [
    {
      key: 'number',
      label: 'Number',
      sortKey: 'number',
      width: '150px',
      render: (r) => <span className="mono">{r.number}</span>,
    },
    {
      key: 'customer',
      label: 'Customer',
      render: (r) => (
        <div>
          <div>{r.customer.name}</div>
          <div className="faint">{r.job ? `${r.job.number} — ${r.job.name}` : 'No project'}</div>
        </div>
      ),
    },
    {
      key: 'invoiceDate',
      label: 'Dated',
      sortKey: 'invoiceDate',
      render: (r) => formatDate(r.invoiceDate),
      optional: true,
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
      key: 'invoiceTotal',
      label: 'Invoiced',
      align: 'right',
      render: (r) => <span className="mono faint">{formatMoney(r.invoiceTotal)}</span>,
    },
    {
      key: 'netCollectible',
      label: 'Collectible',
      align: 'right',
      render: (r) => (
        <div>
          <div className="mono">{formatMoney(r.netCollectible)}</div>
          {r.ewtAmount > 0 && (
            <div className="faint" title="Withheld at source — comes back as a BIR 2307, not as cash">
              less {formatMoney(r.ewtAmount)} EWT
            </div>
          )}
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
      key: 'status',
      label: 'Status',
      render: (r) => <span className={`badge ${tone(r.status)}`}>{label(r.status)}</span>,
    },
  ];

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Accounts Receivable</h1>
          <p>
            Outstanding is measured against what is <strong>collectible</strong>, not against the
            invoice total. The withheld EWT comes back as a tax certificate, so counting it as a
            debt would make every customer look like a late payer.
          </p>
        </div>
      </div>

      {queue && queue.length > 0 && (
        <div className="card">
          <h3 className="card-title">
            {queue.length} approved billing{queue.length === 1 ? '' : 's'} waiting to be invoiced
          </h3>
          <p className="muted">
            The work is approved and the figures are settled. Raising the invoice carries them
            across — nothing is retyped.
          </p>
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Billing</th>
                  <th>Project</th>
                  <th className="right">Invoice total</th>
                  <th className="right">Collectible</th>
                  <th className="right">Waiting</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {queue.map((b) => (
                  <tr key={b.id}>
                    <td>
                      <span className="mono">{b.number}</span>
                      <div className="faint">Billing #{b.billingNo}</div>
                    </td>
                    <td>
                      <div>{b.job.customer.name}</div>
                      <div className="faint">
                        {b.job.number} — {b.job.name}
                      </div>
                    </td>
                    <td className="right mono">{formatMoney(b.invoiceTotal)}</td>
                    <td className="right mono">{formatMoney(b.netCollectible)}</td>
                    <td className="right">
                      <span className={b.waitingDays > 7 ? 'warn' : 'faint'}>{b.waitingDays}d</span>
                    </td>
                    <td className="right">
                      {can('gfin.ar.create') && (
                        <button className="btn btn-sm btn-primary" onClick={() => setRaising(b)}>
                          Raise invoice
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

      <DataList<Invoice>
        listKey="invoices"
        endpoint="/invoices"
        columns={columns}
        rowKey={(r) => r.id}
        reloadToken={reload}
        searchPlaceholder="Search number, customer, PO reference…"
        emptyTitle="No invoices yet"
        onRowClick={(r) => navigate(`/g-fin/ar/${r.id}`)}
        filters={[
          { key: 'status', label: 'Status', options: INVOICE_STATUSES },
          {
            key: 'outstanding',
            label: 'Balance',
            options: [
              { value: 'true', label: 'Outstanding only' },
            ],
          },
          { key: 'overdue', label: 'Overdue', options: [{ value: 'true', label: 'Overdue only' }] },
        ]}
      />

      {raising && (
        <RaiseInvoiceModal
          billing={raising}
          onClose={() => setRaising(null)}
          onRaised={(id) => {
            setRaising(null);
            setReload((r) => r + 1);
            navigate(`/g-fin/ar/${id}`);
          }}
        />
      )}
    </div>
  );
}

function RaiseInvoiceModal({
  billing,
  onClose,
  onRaised,
}: {
  billing: UninvoicedBilling;
  onClose: () => void;
  onRaised: (id: string) => void;
}) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [terms, setTerms] = useState(30);
  const today = new Date().toISOString().slice(0, 10);
  const [form, setForm] = useState({ invoiceDate: today, poReference: '', notes: '' });

  const dueDate = (() => {
    const d = new Date(`${form.invoiceDate}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + terms);
    return d.toISOString().slice(0, 10);
  })();

  async function raise() {
    setBusy(true);
    setError(null);
    try {
      const created = await api.post<{ id: string }>(`/invoices/from-billing/${billing.id}`, {
        invoiceDate: form.invoiceDate,
        dueDate,
        terms: `${terms} days`,
        poReference: form.poReference || null,
        notes: form.notes || null,
      });
      toast('ok', 'Invoice raised — issue it when it goes to the customer');
      onRaised(created.id);
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  }

  return (
    <Modal
      title={`Invoice ${billing.number}`}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button className="btn btn-primary" onClick={raise} disabled={busy}>
            {busy ? 'Raising…' : 'Raise invoice'}
          </button>
        </>
      }
    >
      <ErrorBox error={error} />
      <div className="alert info">
        Every figure is carried from the billing — the gross, both tax rates and the line
        breakdown. Nothing is recomputed, so an invoice raised months later still prints the tax it
        was billed under.
      </div>

      <dl className="kv">
        <dt>Customer</dt>
        <dd>{billing.job.customer.name}</dd>
        <dt>Project</dt>
        <dd>
          <span className="mono">{billing.job.number}</span> — {billing.job.name}
        </dd>
        <dt>Invoice total</dt>
        <dd className="mono">{formatMoney(billing.invoiceTotal)}</dd>
        <dt>Collectible</dt>
        <dd className="mono">{formatMoney(billing.netCollectible)}</dd>
      </dl>

      <div className="grid grid-2" style={{ marginTop: 14 }}>
        <Field label="Invoice date">
          <input
            type="date"
            value={form.invoiceDate}
            onChange={(e) => setForm({ ...form, invoiceDate: e.target.value })}
          />
        </Field>
        <Field label="Terms (days)" hint={`Due ${formatDate(dueDate)}`}>
          <input
            type="number"
            min={0}
            max={365}
            value={terms}
            onChange={(e) => setTerms(Number(e.target.value))}
          />
        </Field>
      </div>

      <Field label="Customer PO reference" hint="Optional — what they will match it against">
        <input
          value={form.poReference}
          onChange={(e) => setForm({ ...form, poReference: e.target.value })}
        />
      </Field>
    </Modal>
  );
}

// ── One invoice ──────────────────────────────────────────────────────────────

export function InvoiceDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const toast = useToast();
  const { can } = useAuth();
  const [row, setRow] = useState<Invoice | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [paying, setPaying] = useState(false);
  const [certificate, setCertificate] = useState(false);

  const load = useCallback(async () => {
    try {
      setRow(await api.get<Invoice>(`/invoices/${id}`));
    } catch (err) {
      setError(err);
    }
  }, [id]);

  useEffect(() => {
    load();
  }, [load]);

  if (error) return <ErrorBox error={error} />;
  if (!row) return <Loading />;

  async function issue() {
    try {
      await api.post(`/invoices/${id}/issue`);
      toast('ok', 'Issued — it is now a receivable');
      load();
    } catch (err) {
      setError(err);
    }
  }

  return (
    <div>
      <div className="breadcrumb">
        <button className="btn btn-ghost btn-sm" onClick={() => navigate('/g-fin/ar')}>
          ← Receivables
        </button>
      </div>

      <div className="page-head">
        <div>
          <h1>
            <span className="mono">{row.number}</span>{' '}
            <span className={`badge ${tone(row.status)}`}>{label(row.status)}</span>
          </h1>
          <p>
            {row.customer.name}
            {row.job && (
              <>
                {' · '}
                <Link to={`/g-ops/projects/${row.job.id}`} className="mono">
                  {row.job.number}
                </Link>
              </>
            )}
            {row.progressBilling && <> · from {row.progressBilling.number}</>}
          </p>
        </div>
        <div className="row">
          {row.status === 'DRAFT' && can('gfin.ar.edit_all') && (
            <button className="btn btn-primary btn-sm" onClick={issue}>
              Issue to customer
            </button>
          )}
          {(row.status === 'ISSUED' || row.status === 'PARTIALLY_PAID') && can('gfin.ar.create') && (
            <button className="btn btn-primary btn-sm" onClick={() => setPaying(true)}>
              Record collection
            </button>
          )}
          {row.ewtAmount > 0 && can('gfin.ar.edit_all') && (
            <button className="btn btn-sm" onClick={() => setCertificate(true)}>
              {row.ewtCertificateNo ? 'Edit BIR 2307' : 'Record BIR 2307'}
            </button>
          )}
        </div>
      </div>

      {row.outstanding > 0 && row.daysOverdue > 0 && (
        <div className="alert warn">
          {row.daysOverdue} days past due. {formatMoney(row.outstanding)} outstanding.
        </div>
      )}

      <div className="grid grid-2">
        <div className="card">
          <h3 className="card-title">What was invoiced</h3>
          <div className="table-wrap">
            <table className="data">
              <tbody>
                {row.lines.map((l) => (
                  <tr key={l.id}>
                    <td>
                      <div>{l.description}</div>
                      {l.detail && <div className="faint">{l.detail}</div>}
                    </td>
                    <td className="right mono">{formatMoney(l.amount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <dl className="kv" style={{ marginTop: 14 }}>
            <dt>Gross</dt>
            <dd className="mono">{formatMoney(row.grossAmount)}</dd>
            <dt>Add: VAT {(row.vatRate * 100).toFixed(0)}%</dt>
            <dd className="mono">{formatMoney(row.vatAmount)}</dd>
            <dt>
              <strong>Invoice total</strong>
            </dt>
            <dd className="mono">
              <strong>{formatMoney(row.invoiceTotal)}</strong>
            </dd>
            <dt>Less: EWT {(row.ewtRate * 100).toFixed(0)}%</dt>
            <dd className="mono">({formatMoney(row.ewtAmount)})</dd>
            <dt>
              <strong>Net collectible</strong>
            </dt>
            <dd className="mono">
              <strong>{formatMoney(row.netCollectible)}</strong>
            </dd>
          </dl>

          {row.ewtAmount > 0 && (
            <div className={`alert ${row.ewtCertificateNo ? 'ok' : 'warn'}`} style={{ marginTop: 14, marginBottom: 0 }}>
              {row.ewtCertificateNo ? (
                <>
                  BIR 2307 <span className="mono">{row.ewtCertificateNo}</span> received
                  {row.ewtCertificateAt && <> on {formatDate(row.ewtCertificateAt)}</>} —{' '}
                  {formatMoney(row.ewtAmount)} is creditable.
                </>
              ) : (
                <>
                  {formatMoney(row.ewtAmount)} was withheld at source and no BIR 2307 has been
                  recorded. That is a tax credit sitting with the customer — worth chasing, but it
                  is <strong>not</strong> an unpaid balance.
                </>
              )}
            </div>
          )}
        </div>

        <div>
          <div className="card">
            <h3 className="card-title">Where it stands</h3>
            <dl className="kv">
              <dt>Dated</dt>
              <dd>{formatDate(row.invoiceDate)}</dd>
              <dt>Due</dt>
              <dd>
                {formatDate(row.dueDate)}
                {row.terms && <span className="faint"> · {row.terms}</span>}
              </dd>
              <dt>Collected</dt>
              <dd className="mono">{formatMoney(row.amountCollected)}</dd>
              <dt>Outstanding</dt>
              <dd className="mono">
                <strong>{formatMoney(row.outstanding)}</strong>
              </dd>
              {row.poReference && (
                <>
                  <dt>Their PO</dt>
                  <dd className="mono">{row.poReference}</dd>
                </>
              )}
            </dl>
          </div>

          <div className="card">
            <h3 className="card-title">Collections</h3>
            {!row.allocations?.length ? (
              <p className="muted" style={{ marginBottom: 0 }}>
                Nothing collected yet.
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
                            {formatDate(a.payment.paymentDate)} · {a.payment.method.toLowerCase().replace(/_/g, ' ')}
                            {a.payment.reference && ` · ${a.payment.reference}`}
                          </div>
                        </td>
                        <td className="right">
                          <div className="mono">{formatMoney(a.amount)}</div>
                          {!a.payment.clearedAt && (
                            <div className="faint warn" title="Not cash until it clears">
                              uncleared
                            </div>
                          )}
                        </td>
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
          kind="RECEIPT"
          party={{ id: row.customer.id, name: row.customer.name }}
          target={{ kind: 'invoice', id: row.id, number: row.number, outstanding: row.outstanding }}
          onClose={() => setPaying(false)}
          onSaved={() => {
            setPaying(false);
            load();
          }}
        />
      )}

      {certificate && (
        <CertificateModal
          invoice={row}
          onClose={() => setCertificate(false)}
          onSaved={() => {
            setCertificate(false);
            load();
          }}
        />
      )}
    </div>
  );
}

function CertificateModal({
  invoice,
  onClose,
  onSaved,
}: {
  invoice: Invoice;
  onClose: () => void;
  onSaved: () => void;
}) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [form, setForm] = useState({
    ewtCertificateNo: invoice.ewtCertificateNo ?? '',
    ewtCertificateAt: invoice.ewtCertificateAt?.slice(0, 10) ?? new Date().toISOString().slice(0, 10),
  });

  async function save() {
    setBusy(true);
    setError(null);
    try {
      await api.patch(`/invoices/${invoice.id}/certificate`, {
        ewtCertificateNo: form.ewtCertificateNo || null,
        ewtCertificateAt: form.ewtCertificateNo ? form.ewtCertificateAt : null,
      });
      toast('ok', 'Certificate recorded');
      onSaved();
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  }

  return (
    <Modal
      title="BIR Form 2307"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button className="btn btn-primary" onClick={save} disabled={busy}>
            {busy ? 'Saving…' : 'Save'}
          </button>
        </>
      }
    >
      <ErrorBox error={error} />
      <p className="muted">
        {formatMoney(invoice.ewtAmount)} was withheld on this invoice. The certificate is what
        makes it creditable against Gruntech's own tax — without it the money is simply gone.
      </p>
      <Field label="Certificate number">
        <input
          value={form.ewtCertificateNo}
          onChange={(e) => setForm({ ...form, ewtCertificateNo: e.target.value })}
          placeholder="As printed on the form"
        />
      </Field>
      <Field label="Received on">
        <input
          type="date"
          value={form.ewtCertificateAt}
          onChange={(e) => setForm({ ...form, ewtCertificateAt: e.target.value })}
        />
      </Field>
    </Modal>
  );
}

// ── Recording money ──────────────────────────────────────────────────────────

export interface PayTarget {
  kind: 'invoice' | 'bill' | 'claim';
  id: string;
  number: string;
  outstanding: number;
}

/**
 * One payment, allocated across the documents it settles.
 *
 * Opened against one document but able to take on others, because a customer
 * paying three billings with one cheque is the normal case, not the exception.
 */
export function RecordPaymentModal({
  kind,
  party,
  target,
  onClose,
  onSaved,
}: {
  kind: 'RECEIPT' | 'DISBURSEMENT';
  party?: { id: string; name: string };
  target: PayTarget;
  onClose: () => void;
  onSaved: () => void;
}) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [others, setOthers] = useState<PayTarget[]>([]);
  const [allocations, setAllocations] = useState<Record<string, number>>({
    [target.id]: target.outstanding,
  });
  const [form, setForm] = useState({
    method: 'BANK_TRANSFER',
    paymentDate: new Date().toISOString().slice(0, 10),
    reference: '',
    bank: '',
    notes: '',
  });

  useEffect(() => {
    api
      .get<(PayTarget & { number: string; outstanding: number })[]>(
        `/payments/open/${target.kind}${party ? `?partyId=${party.id}` : ''}`,
      )
      .then((rows) =>
        setOthers(
          rows
            .filter((r) => r.id !== target.id)
            .map((r) => ({ kind: target.kind, id: r.id, number: r.number, outstanding: r.outstanding })),
        ),
      )
      .catch(() => {});
  }, [target.kind, target.id, party]);

  const total = Object.values(allocations).reduce((s, v) => s + (v || 0), 0);
  const overApplied = [target, ...others].some(
    (t) => (allocations[t.id] ?? 0) > t.outstanding + 0.005,
  );

  async function save() {
    setBusy(true);
    setError(null);
    try {
      await api.post('/payments', {
        kind,
        method: form.method,
        paymentDate: form.paymentDate,
        customerId: kind === 'RECEIPT' ? party?.id : null,
        supplierId: kind === 'DISBURSEMENT' && target.kind === 'bill' ? party?.id : null,
        payeeUserId: kind === 'DISBURSEMENT' && target.kind === 'claim' ? party?.id : null,
        reference: form.reference || null,
        bank: form.bank || null,
        notes: form.notes || null,
        allocations: Object.entries(allocations)
          .filter(([, amount]) => amount > 0)
          .map(([id, amount]) => ({ kind: target.kind, id, amount })),
      });
      toast('ok', kind === 'RECEIPT' ? 'Collection recorded' : 'Payment recorded');
      onSaved();
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  }

  const rows = [target, ...others];

  return (
    <Modal
      title={kind === 'RECEIPT' ? 'Record a collection' : 'Record a payment'}
      onClose={onClose}
      wide
      footer={
        <>
          <button className="btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button
            className="btn btn-primary"
            onClick={save}
            disabled={busy || total <= 0 || overApplied}
          >
            {busy ? 'Recording…' : `Record ${formatMoney(total)}`}
          </button>
        </>
      }
    >
      <ErrorBox error={error} />

      <div className="grid grid-2">
        <Field label="Date">
          <input
            type="date"
            value={form.paymentDate}
            onChange={(e) => setForm({ ...form, paymentDate: e.target.value })}
          />
        </Field>
        <Field label="Method">
          <select value={form.method} onChange={(e) => setForm({ ...form, method: e.target.value })}>
            <option value="BANK_TRANSFER">Bank transfer</option>
            <option value="CHECK">Cheque</option>
            <option value="CASH">Cash</option>
            <option value="ONLINE">Online</option>
            <option value="OFFSET">Offset</option>
          </select>
        </Field>
      </div>

      <div className="grid grid-2">
        <Field label="Reference" hint="Cheque number, transfer reference, OR number">
          <input
            value={form.reference}
            onChange={(e) => setForm({ ...form, reference: e.target.value })}
          />
        </Field>
        <Field label="Bank">
          <input value={form.bank} onChange={(e) => setForm({ ...form, bank: e.target.value })} />
        </Field>
      </div>

      {form.method === 'CHECK' && (
        <div className="alert warn">
          A cheque is recorded now but stays uncleared until you say it has cleared. Cash flow
          counts cleared money only — a position that counts promises is the one that bounces.
        </div>
      )}

      <h4 style={{ marginTop: 18, marginBottom: 8 }}>What it settles</h4>
      <div className="table-wrap">
        <table className="data">
          <thead>
            <tr>
              <th>Document</th>
              <th className="right">Outstanding</th>
              <th className="right" style={{ width: 160 }}>
                Applying
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((t) => (
              <tr key={t.id}>
                <td className="mono">{t.number}</td>
                <td className="right mono">{formatMoney(t.outstanding)}</td>
                <td className="right">
                  <input
                    type="number"
                    step="0.01"
                    min={0}
                    max={t.outstanding}
                    value={allocations[t.id] ?? ''}
                    onChange={(e) =>
                      setAllocations({ ...allocations, [t.id]: Number(e.target.value) })
                    }
                    style={{ textAlign: 'right' }}
                  />
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <th colSpan={2} className="right">
                Total
              </th>
              <th className="right mono">{formatMoney(total)}</th>
            </tr>
          </tfoot>
        </table>
      </div>

      {overApplied && (
        <div className="alert error" style={{ marginTop: 12, marginBottom: 0 }}>
          One of these is being over-applied. A document cannot be paid more than it still owes.
        </div>
      )}
      {rows.length === 1 && (
        <p className="faint" style={{ marginTop: 10 }}>
          Nothing else is open for this {kind === 'RECEIPT' ? 'customer' : 'payee'}.
        </p>
      )}
    </Modal>
  );
}

// ── The payments register ────────────────────────────────────────────────────

interface PaymentRow {
  id: string;
  number: string;
  kind: string;
  method: string;
  paymentDate: string;
  amount: number;
  reference: string | null;
  bank: string | null;
  clearedAt: string | null;
  customer: { id: string; name: string } | null;
  supplier: { id: string; name: string } | null;
  payeeUser: { id: string; name: string } | null;
  recordedBy: { id: string; name: string };
  allocations: { id: string; amount: number }[];
}

export function Payments() {
  const { can } = useAuth();
  const toast = useToast();
  const [reload, setReload] = useState(0);
  const [error, setError] = useState<unknown>(null);

  async function clear(id: string) {
    try {
      await api.post(`/payments/${id}/clear`);
      toast('ok', 'Marked cleared');
      setReload((r) => r + 1);
    } catch (err) {
      setError(err);
    }
  }

  const columns: Column<PaymentRow>[] = [
    {
      key: 'number',
      label: 'Number',
      sortKey: 'number',
      width: '150px',
      render: (r) => <span className="mono">{r.number}</span>,
    },
    {
      key: 'paymentDate',
      label: 'Date',
      sortKey: 'paymentDate',
      render: (r) => formatDate(r.paymentDate),
    },
    {
      key: 'party',
      label: 'Who',
      render: (r) => (
        <div>
          <div>{r.customer?.name ?? r.supplier?.name ?? r.payeeUser?.name ?? '—'}</div>
          <div className="faint">
            {r.method.toLowerCase().replace(/_/g, ' ')}
            {r.reference && ` · ${r.reference}`}
          </div>
        </div>
      ),
    },
    {
      key: 'kind',
      label: 'Direction',
      render: (r) => (
        <span className={`badge ${r.kind === 'RECEIPT' ? 'ok' : ''}`}>
          {r.kind === 'RECEIPT' ? 'money in' : 'money out'}
        </span>
      ),
    },
    {
      key: 'allocations',
      label: 'Settles',
      align: 'right',
      render: (r) => `${r.allocations.length} document${r.allocations.length === 1 ? '' : 's'}`,
      optional: true,
    },
    {
      key: 'amount',
      label: 'Amount',
      sortKey: 'amount',
      align: 'right',
      render: (r) => <span className="mono">{formatMoney(r.amount)}</span>,
    },
    {
      key: 'cleared',
      label: 'Cleared',
      render: (r) =>
        r.clearedAt ? (
          <span className="faint">{formatDate(r.clearedAt)}</span>
        ) : (
          <span className="row" style={{ gap: 6 }}>
            <span className="badge warn">uncleared</span>
            {can('gfin.ar.edit_all') && (
              <button
                className="btn btn-ghost btn-sm"
                onClick={(e) => {
                  e.stopPropagation();
                  clear(r.id);
                }}
              >
                clear
              </button>
            )}
          </span>
        ),
    },
  ];

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Payments</h1>
          <p>
            Every movement of money, in and out, and what each one settled. An uncleared cheque is
            recorded but does not count towards cash — it is a promise until the bank says
            otherwise.
          </p>
        </div>
      </div>

      <ErrorBox error={error} />

      <DataList<PaymentRow>
        listKey="payments"
        endpoint="/payments"
        columns={columns}
        rowKey={(r) => r.id}
        reloadToken={reload}
        searchPlaceholder="Search number, reference, customer, supplier…"
        emptyTitle="No payments recorded yet"
        filters={[
          {
            key: 'kind',
            label: 'Direction',
            options: [
              { value: 'RECEIPT', label: 'Money in' },
              { value: 'DISBURSEMENT', label: 'Money out' },
            ],
          },
          { key: 'uncleared', label: 'Cleared', options: [{ value: 'true', label: 'Uncleared only' }] },
        ]}
      />
    </div>
  );
}
