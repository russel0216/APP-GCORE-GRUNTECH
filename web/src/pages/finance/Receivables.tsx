import { useCallback, useEffect, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { DataList, type Column } from '../../components/DataList';
import { RecordHeader } from '../../components/RecordHeader';
import { useConfirm } from '../../components/Confirm';
import {
  ErrorBox,
  Field,
  Loading,
  Modal,
  ModalFoot,
  StatusBadge,
  formatDate,
  formatMoney,
  humanise,
  useToast,
} from '../../components/ui';
import { todayLocal } from '../../lib/day';
import { NumberInput } from '../../components/NumberInput';

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
  jobOrder: { id: string; number: string } | null;
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

/**
 * A link inside a clickable table row. The row opens its own record on click
 * and on Enter; without this the link's own click and keypress would bubble
 * up and open the row's record as well, or be swallowed by it.
 */
export function CellLink({ to, children, className }: { to: string; children: ReactNode; className?: string }) {
  const stop = (e: MouseEvent | KeyboardEvent) => e.stopPropagation();
  return (
    <Link to={to} className={className} onClick={stop} onKeyDown={stop}>
      {children}
    </Link>
  );
}

/** Where a payment's number opens: the register, with that payment's sheet up. */
export const paymentLink = (id: string) => `/g-fin/payments?payment=${id}`;

export function Receivables() {
  const { can } = useAuth();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const [queue, setQueue] = useState<UninvoicedBilling[] | null>(null);
  const [raising, setRaising] = useState<UninvoicedBilling | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
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

  // `?raise=<billingId>` — the billing page's "Raise invoice" lands here with
  // the modal already open, rather than on a list to hunt through.
  const raiseId = params.get('raise');
  useEffect(() => {
    if (!raiseId || !queue) return;
    const match = queue.find((b) => b.id === raiseId);
    if (match && can('gfin.ar.create')) setRaising(match);
    else if (!match) {
      setNotice('That billing is not waiting to be invoiced — it may already have an invoice, or not be approved yet.');
    }
    const next = new URLSearchParams(params);
    next.delete('raise');
    setParams(next, { replace: true });
  }, [raiseId, queue, can, params, setParams]);

  const columns: Column<Invoice>[] = [
    {
      key: 'number',
      label: 'Number',
      sortKey: 'number',
      render: (r) => <span className="mono">{r.number}</span>,
    },
    {
      key: 'customer',
      label: 'Customer',
      render: (r) => (
        <div>
          <div>{r.customer.name}</div>
          <div className="faint">
            {r.job ? `${r.job.number} — ${r.job.name}` : r.jobOrder ? `Job order ${r.jobOrder.number}` : 'No project'}
          </div>
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
      render: (r) => <StatusBadge status={r.status} />,
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

      {notice && <div className="alert warn">{notice}</div>}

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
                      <Link to={`/g-ops/billings/${b.id}`} className="mono">
                        {b.number}
                      </Link>
                      <div className="faint">Billing #{b.billingNo}</div>
                    </td>
                    <td>
                      <div>{b.job.customer.name}</div>
                      <div className="faint">
                        <Link to={`/g-ops/projects/${b.job.id}`} className="mono">
                          {b.job.number}
                        </Link>{' '}
                        — {b.job.name}
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
            options: [{ value: 'true', label: 'Outstanding only' }],
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
  const today = todayLocal();
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
      title={`New invoice from ${billing.number}`}
      onClose={onClose}
      footer={
        <ModalFoot onCancel={onClose} busy={busy}>
          <button className="btn btn-primary" onClick={raise} disabled={busy}>
            {busy ? 'Raising…' : 'Raise invoice'}
          </button>
        </ModalFoot>
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

      <div className="grid grid-2 fin-gap-top">
        <Field label="Invoice date">
          <input
            type="date"
            value={form.invoiceDate}
            onChange={(e) => setForm({ ...form, invoiceDate: e.target.value })}
          />
        </Field>
        <Field label="Terms (days)" hint={`Due ${formatDate(dueDate)}`}>
          <NumberInput
            kind="count"
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
  const toast = useToast();
  const { can } = useAuth();
  const [row, setRow] = useState<Invoice | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [paying, setPaying] = useState(false);
  const [certificate, setCertificate] = useState(false);
  const confirm = useConfirm();

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

  if (error && !row) return <ErrorBox error={error} />;
  if (!row) return <Loading />;

  // Thrown, not caught: the confirm bar shows the refusal and stays open.
  async function issue() {
    await api.post(`/invoices/${id}/issue`);
    toast('ok', 'Issued — it is now a receivable');
    await load();
  }

  return (
    <div>
      <RecordHeader
        type="Sales Invoice"
        code={row.number}
        title={row.customer.name}
        status={row.status}
        amount={formatMoney(row.netCollectible)}
        // What will actually arrive, not what the invoice prints — see the
        // header of this file.
        amountLabel="Net collectible"
        meta={
          <>
            <Link to={`/g-ops/customers/${row.customer.id}`}>{row.customer.name}</Link>
            {row.job && (
              <>
                {' · '}
                <Link to={`/g-ops/projects/${row.job.id}`} className="mono">
                  {row.job.number}
                </Link>{' '}
                {row.job.name}
              </>
            )}
            {row.progressBilling && (
              <>
                {' · from '}
                <Link to={`/g-ops/billings/${row.progressBilling.id}`} className="mono">
                  {row.progressBilling.number}
                </Link>
              </>
            )}
            {row.jobOrder && (
              <>
                {' · for job order '}
                <Link to={`/g-ops/job-orders/${row.jobOrder.id}`} className="mono">
                  {row.jobOrder.number}
                </Link>
              </>
            )}
          </>
        }
        actions={
          <>
            {row.status === 'DRAFT' && can('gfin.ar.edit_all') && (
              <button
                className="btn btn-primary"
                onClick={() =>
                  confirm.ask({
                    title: `Issue ${row.number} to ${row.customer.name}?`,
                    body: `It becomes a receivable: ${formatMoney(row.netCollectible)} collectible, due ${formatDate(row.dueDate)}.`,
                    confirmLabel: 'Issue to customer',
                    tone: 'primary',
                    onConfirm: issue,
                  })
                }
              >
                Issue to customer
              </button>
            )}
            {(row.status === 'ISSUED' || row.status === 'PARTIALLY_PAID') && can('gfin.ar.create') && (
              <button className="btn btn-primary" onClick={() => setPaying(true)}>
                Record collection
              </button>
            )}
          </>
        }
        print={`/api/invoices/${row.id}/pdf`}
        more={[
          row.ewtAmount > 0 &&
            can('gfin.ar.edit_all') && {
              label: row.ewtCertificateNo ? 'Modify BIR 2307' : 'Record BIR 2307',
              hint: 'The certificate for the EWT withheld at source',
              onSelect: () => setCertificate(true),
            },
        ]}
        confirm={confirm}
      />

      <ErrorBox error={error} />

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

          <dl className="kv fin-gap-top">
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
            <div className={`alert ${row.ewtCertificateNo ? 'ok' : 'warn'} fin-gap-top fin-flush`}>
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
              <p className="muted fin-flush">Nothing collected yet.</p>
            ) : (
              <div className="table-wrap">
                <table className="data">
                  <tbody>
                    {row.allocations.map((a) => (
                      <tr key={a.id}>
                        <td>
                          <Link to={paymentLink(a.payment.id)} className="mono">
                            {a.payment.number}
                          </Link>
                          <div className="faint">
                            {formatDate(a.payment.paymentDate)} · {humanise(a.payment.method)}
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
    ewtCertificateAt: invoice.ewtCertificateAt?.slice(0, 10) ?? todayLocal(),
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
      title={
        invoice.ewtCertificateNo
          ? `Modify BIR 2307 ${invoice.ewtCertificateNo}`
          : `Record BIR 2307 for ${invoice.number}`
      }
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

/**
 * What a payment settles.
 *
 * `advance` is the release of a cash advance (money out, all of it in one
 * voucher); `advance_refund` is unspent advance money coming back (money in —
 * but never a customer collection). `budget_request` and
 * `budget_request_refund` are the same two movements on project cash.
 */
export interface PayTarget {
  kind: 'invoice' | 'bill' | 'claim' | 'advance' | 'advance_refund' | 'budget_request' | 'budget_request_refund';
  id: string;
  number: string;
  outstanding: number;
}

/** Cash handed to a person, all of it in one voucher. */
const RELEASE_KINDS: PayTarget['kind'][] = ['advance', 'budget_request'];
/** Unspent cash coming back from a person — money in, never a collection. */
const REFUND_KINDS: PayTarget['kind'][] = ['advance_refund', 'budget_request_refund'];
/** The counterparty is a person, not a customer or a supplier. */
const PERSON_KINDS: PayTarget['kind'][] = ['claim', ...RELEASE_KINDS, ...REFUND_KINDS];

/** Who the counterparty is, by what is being settled. */
function partyFields(kind: PayTarget['kind'], partyId: string | undefined) {
  return {
    customerId: kind === 'invoice' ? partyId ?? null : null,
    supplierId: kind === 'bill' ? partyId ?? null : null,
    // A person: a reimbursement, cash handed over, or unspent cash back.
    payeeUserId: PERSON_KINDS.includes(kind) ? partyId ?? null : null,
  };
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
  const person = PERSON_KINDS.includes(target.kind);
  const release = RELEASE_KINDS.includes(target.kind);
  const refund = REFUND_KINDS.includes(target.kind);
  const cashWord = target.kind.startsWith('budget_request') ? 'budget request' : 'advance';
  const [form, setForm] = useState({
    // Releases and refunds are usually cash across a desk; everything else a transfer.
    method: release || refund ? 'CASH' : 'BANK_TRANSFER',
    paymentDate: todayLocal(),
    reference: '',
    bank: '',
    notes: '',
  });

  useEffect(() => {
    api
      .get<{ id: string; number: string; outstanding: number }[]>(
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

  const rows = [target, ...others];
  const total = Object.values(allocations).reduce((s, v) => s + (v || 0), 0);
  const overApplied = rows.some((t) => (allocations[t.id] ?? 0) > t.outstanding + 0.005);
  // An advance or a budget request goes out in one voucher: all of it, or none of it.
  const partialRelease =
    release &&
    rows.some((t) => {
      const v = allocations[t.id] ?? 0;
      return v > 0 && Math.abs(v - t.outstanding) > 0.005;
    });

  async function save() {
    setBusy(true);
    setError(null);
    try {
      await api.post('/payments', {
        kind,
        method: form.method,
        paymentDate: form.paymentDate,
        ...partyFields(target.kind, party?.id),
        reference: form.reference || null,
        bank: form.bank || null,
        notes: form.notes || null,
        allocations: Object.entries(allocations)
          .filter(([, amount]) => amount > 0)
          .map(([id, amount]) => ({ kind: target.kind, id, amount })),
      });
      toast(
        'ok',
        release
          ? 'Released — the liquidation clock has started'
          : refund
            ? 'Refund recorded'
            : kind === 'RECEIPT'
              ? 'Collection recorded'
              : 'Payment recorded',
      );
      onSaved();
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  }

  const title = release
    ? `Release a ${cashWord === 'advance' ? 'cash advance' : 'budget request'}`
    : refund
      ? 'Record unspent cash returned'
      : kind === 'RECEIPT'
        ? 'Record a collection'
        : 'Record a payment';

  return (
    <Modal
      title={title}
      onClose={onClose}
      wide
      footer={
        <ModalFoot onCancel={onClose} busy={busy}>
          <button
            className="btn btn-primary"
            onClick={save}
            disabled={busy || total <= 0 || overApplied || partialRelease}
          >
            {busy ? 'Recording…' : `Record ${formatMoney(total)}`}
          </button>
        </ModalFoot>
      }
    >
      <ErrorBox error={error} />

      {party && (
        <p className="muted">
          {kind === 'RECEIPT' ? 'From' : 'To'} <strong>{party.name}</strong>
        </p>
      )}
      {release && (
        <div className="alert info">
          {cashWord === 'advance' ? 'An advance' : 'A budget request'} is released in one voucher, for the whole amount. The
          person then has a set number of days from this payment date to file the receipts as a
          liquidation.
        </div>
      )}
      {refund && (
        <div className="alert info">
          Unspent {cashWord} money coming back. It is cash in, but it is not a collection — it never
          counts towards what customers have paid.
        </div>
      )}

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
        <Field label="Reference" hint="Cheque number, transfer reference, OR or voucher number">
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

      <h4 className="fin-section-title">What it settles</h4>
      <div className="table-wrap">
        <table className="data">
          <thead>
            <tr>
              <th>Document</th>
              <th className="right">Outstanding</th>
              <th className="right">Applying</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((t) => (
              <tr key={t.id}>
                <td className="mono">{t.number}</td>
                <td className="right mono">{formatMoney(t.outstanding)}</td>
                <td className="right">
                  <NumberInput
                    kind="money"
                    step="0.01"
                    // An advance is all-or-nothing, so its only non-zero value is the whole of it.
                    min={0}
                    max={t.outstanding}
                    aria-label={`Amount applied to ${t.number}`}
                    className="fin-amount-input"
                    value={allocations[t.id] ?? ''}
                    onChange={(e) =>
                      setAllocations({ ...allocations, [t.id]: Number(e.target.value) })
                    }
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
        <div className="alert error fin-gap-top fin-flush">
          One of these is being over-applied. A document cannot be paid more than it still owes.
        </div>
      )}
      {partialRelease && (
        <div className="alert error fin-gap-top fin-flush">
          {cashWord === 'advance' ? 'An advance' : 'A budget request'} is released in one voucher — release the whole amount
          or leave it at zero.
        </div>
      )}
      {rows.length === 1 && (
        <p className="faint fin-gap-top">
          Nothing else is open for this {kind === 'RECEIPT' && !person ? 'customer' : person ? 'person' : 'payee'}.
        </p>
      )}
    </Modal>
  );
}

// ── The payments register ────────────────────────────────────────────────────

interface Allocation {
  id: string;
  amount: number;
  invoice: { id: string; number: string } | null;
  bill: { id: string; number: string } | null;
  claim: { id: string; number: string } | null;
  advance: { id: string; number: string } | null;
  budgetRequest: { id: string; number: string } | null;
}

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
  notes?: string | null;
  customer: { id: string; name: string } | null;
  supplier: { id: string; name: string } | null;
  payeeUser: { id: string; name: string } | null;
  recordedBy: { id: string; name: string };
  allocations: Allocation[];
}

/** Where one allocation's document lives, and what to call it. */
function allocationTarget(a: Allocation, paymentKind: string): { to: string; number: string; what: string } | null {
  if (a.invoice) return { to: `/g-fin/ar/${a.invoice.id}`, number: a.invoice.number, what: 'Invoice' };
  if (a.bill) return { to: `/g-fin/ap/${a.bill.id}`, number: a.bill.number, what: 'Supplier bill' };
  if (a.claim) return { to: `/g-fin/expenses/${a.claim.id}`, number: a.claim.number, what: 'Expense claim' };
  if (a.advance) {
    return {
      to: `/g-fin/cash-advances/${a.advance.id}`,
      number: a.advance.number,
      what: paymentKind === 'RECEIPT' ? 'Advance refund' : 'Advance release',
    };
  }
  if (a.budgetRequest) {
    return {
      to: `/g-ops/budget-requests/${a.budgetRequest.id}`,
      number: a.budgetRequest.number,
      what: paymentKind === 'RECEIPT' ? 'Budget request refund' : 'Budget request release',
    };
  }
  return null;
}

function AllocationLinks({ row }: { row: PaymentRow }) {
  return (
    <span className="fin-links">
      {row.allocations.map((a) => {
        const t = allocationTarget(a, row.kind);
        return t ? (
          <CellLink key={a.id} to={t.to} className="mono">
            {t.number}
          </CellLink>
        ) : null;
      })}
    </span>
  );
}

const partyName = (r: PaymentRow) => r.customer?.name ?? r.supplier?.name ?? r.payeeUser?.name ?? '—';

export function Payments() {
  const { can } = useAuth();
  const [params, setParams] = useSearchParams();
  const [reload, setReload] = useState(0);

  // The API clears on either edit right; the button follows the same rule, so
  // payables staff can clear a supplier cheque the server would accept anyway.
  const canClear = can('gfin.ar.edit_all') || can('gfin.ap.edit_all');
  const openId = params.get('payment');

  const open = (id: string | null) => {
    const next = new URLSearchParams(params);
    if (id) next.set('payment', id);
    else next.delete('payment');
    setParams(next, { replace: !id });
  };

  const columns: Column<PaymentRow>[] = [
    {
      key: 'number',
      label: 'Number',
      sortKey: 'number',
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
          <div>{partyName(r)}</div>
          <div className="faint">
            {humanise(r.method)}
            {r.reference && ` · ${r.reference}`}
          </div>
        </div>
      ),
    },
    {
      key: 'kind',
      label: 'Direction',
      render: (r) => (
        <StatusBadge
          status={r.kind}
          extra={{ RECEIPT: 'ok', DISBURSEMENT: '' }}
          label={r.kind === 'RECEIPT' ? 'money in' : 'money out'}
        />
      ),
    },
    {
      key: 'allocations',
      label: 'Settles',
      render: (r) => <AllocationLinks row={r} />,
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
      // Marking a payment cleared is done on its sheet (the row opens it),
      // where it asks first: it cannot be undone.
      render: (r) =>
        r.clearedAt ? (
          <span className="faint">{formatDate(r.clearedAt)}</span>
        ) : (
          <StatusBadge status="UNCLEARED" extra={{ UNCLEARED: 'warn' }} label="uncleared" />
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

      <DataList<PaymentRow>
        listKey="payments"
        endpoint="/payments"
        columns={columns}
        rowKey={(r) => r.id}
        reloadToken={reload}
        searchPlaceholder="Search number, reference, customer, supplier, person…"
        emptyTitle="No payments recorded yet"
        onRowClick={(r) => open(r.id)}
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

      {openId && (
        <PaymentDetailModal
          id={openId}
          canClear={canClear}
          onClose={() => open(null)}
          onChanged={() => setReload((r) => r + 1)}
        />
      )}
    </div>
  );
}

/**
 * One payment, opened by `?payment=<id>` — so a notification, a report row or
 * an invoice's collection list can point straight at it.
 */
function PaymentDetailModal({
  id,
  canClear,
  onClose,
  onChanged,
}: {
  id: string;
  canClear: boolean;
  onClose: () => void;
  onChanged: () => void;
}) {
  const toast = useToast();
  const confirm = useConfirm();
  const [row, setRow] = useState<PaymentRow | null>(null);
  const [error, setError] = useState<unknown>(null);

  const load = useCallback(async () => {
    try {
      setRow(await api.get<PaymentRow>(`/payments/${id}`));
    } catch (err) {
      setError(err);
    }
  }, [id]);

  useEffect(() => {
    load();
  }, [load]);

  // Thrown, not caught: the confirm bar shows the refusal and stays open.
  async function clear() {
    await api.post(`/payments/${id}/clear`);
    toast('ok', 'Marked cleared');
    await load();
    onChanged();
  }

  return (
    <Modal
      title={row ? `Payment ${row.number}` : 'Payment'}
      onClose={onClose}
      wide
      footer={
        <ModalFoot onCancel={onClose} cancelLabel="Close">
          {row && !row.clearedAt && canClear && (
            <button
              className="btn"
              disabled={confirm.open}
              onClick={() =>
                confirm.ask({
                  title: `Mark ${row.number} cleared?`,
                  body: 'From today it counts as cash. It cannot be set back to uncleared.',
                  confirmLabel: 'Mark cleared',
                  tone: 'primary',
                  onConfirm: clear,
                })
              }
            >
              Mark cleared
            </button>
          )}
        </ModalFoot>
      }
    >
      {confirm.bar}
      <ErrorBox error={error} />
      {!row && !error && <Loading />}
      {row && (
        <>
          <dl className="kv">
            <dt>Direction</dt>
            <dd>
              <StatusBadge
                status={row.kind}
                extra={{ RECEIPT: 'ok', DISBURSEMENT: '' }}
                label={row.kind === 'RECEIPT' ? 'money in' : 'money out'}
              />
            </dd>
            <dt>{row.kind === 'RECEIPT' ? 'From' : 'To'}</dt>
            <dd>
              {row.customer ? (
                <Link to={`/g-ops/customers/${row.customer.id}`}>{row.customer.name}</Link>
              ) : row.supplier ? (
                <Link to={`/g-chain/suppliers/${row.supplier.id}`}>{row.supplier.name}</Link>
              ) : (
                partyName(row)
              )}
            </dd>
            <dt>Date</dt>
            <dd>{formatDate(row.paymentDate)}</dd>
            <dt>Amount</dt>
            <dd className="mono">
              <strong>{formatMoney(row.amount)}</strong>
            </dd>
            <dt>Method</dt>
            <dd>{humanise(row.method)}</dd>
            <dt>Reference</dt>
            <dd className="mono">{row.reference ?? '—'}</dd>
            <dt>Bank</dt>
            <dd>{row.bank ?? '—'}</dd>
            <dt>Cleared</dt>
            <dd>
              {row.clearedAt ? (
                formatDate(row.clearedAt)
              ) : (
                <StatusBadge status="UNCLEARED" extra={{ UNCLEARED: 'warn' }} label="not yet — not cash until it clears" />
              )}
            </dd>
            <dt>Recorded by</dt>
            <dd>{row.recordedBy.name}</dd>
            {row.notes && (
              <>
                <dt>Notes</dt>
                <dd>{row.notes}</dd>
              </>
            )}
          </dl>

          <h4 className="fin-section-title">What it settled</h4>
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Document</th>
                  <th>Kind</th>
                  <th className="right">Applied</th>
                </tr>
              </thead>
              <tbody>
                {row.allocations.map((a) => {
                  const t = allocationTarget(a, row.kind);
                  return (
                    <tr key={a.id}>
                      <td>
                        {t ? (
                          <Link to={t.to} className="mono">
                            {t.number}
                          </Link>
                        ) : (
                          '—'
                        )}
                      </td>
                      <td className="faint">{t?.what ?? '—'}</td>
                      <td className="right mono">{formatMoney(a.amount)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
    </Modal>
  );
}
