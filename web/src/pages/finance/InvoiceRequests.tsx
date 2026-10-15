import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { DataList, type Column } from '../../components/DataList';
import { RecordHeader } from '../../components/RecordHeader';
import { useConfirm } from '../../components/Confirm';
import { ApprovalStepper, DocumentApproval, DecisionNote, previewSteps } from '../../components/ApprovalStepper';
import { Attachments } from '../../components/Attachments';
import { Stat } from '../../components/charts';
import { ErrorBox, Field, Loading, Modal, ModalFoot, StatusBadge, formatDate, formatMoney, useToast, type Tone } from '../../components/ui';
import { EwtPicker, TermsPicker } from './Receivables';
import { NumberInput } from '../../components/NumberInput';

/**
 * INVOICE REQUESTS (2026-10-15, the owner's call): an approved progress
 * billing, asked to be invoiced against the project's sales order by the
 * salesperson holding the project or their Team Leader; Back Support approves
 * it on this page's Approval panel (or from My Work), and the approval raises
 * the DRAFT invoice in Accounts Receivable. The API is `/api/invoice-requests`.
 */

export const REQUEST_TONES: Record<string, Tone> = {
  DRAFT: '',
  PENDING_APPROVAL: 'warn',
  APPROVED: 'ok',
  CANCELLED: 'danger',
};

const STATUSES = [
  { value: 'DRAFT', label: 'Draft' },
  { value: 'PENDING_APPROVAL', label: 'Waiting for Back Support' },
  { value: 'APPROVED', label: 'Approved — invoiced' },
  { value: 'CANCELLED', label: 'Cancelled' },
];

interface Named {
  id: string;
  name: string;
}

interface RequestRow {
  id: string;
  number: string;
  status: string;
  stage: string | null;
  job: { id: string; number: string; name: string } | null;
  customer: Named;
  billing: { id: string; number: string } | null;
  salesOrder: { id: string; number: string };
  poReference: string | null;
  netCollectible: number;
  requestedBy: Named;
  team: { id: string; code: string } | null;
  invoice: { id: string; number: string; status: string } | null;
  createdAt: string;
}

interface Summary {
  waiting: number;
  waitingValue: number;
  drafts: number;
  approvedThisMonth: number;
}

/** G-FIN › Money in › Invoice Requests — the register. */
export function InvoiceRequests() {
  const navigate = useNavigate();
  const columns: Column<RequestRow>[] = [
    { key: 'number', label: 'Number', sortKey: 'number', render: (r) => <span className="mono">{r.number}</span> },
    {
      key: 'job',
      label: 'Project',
      render: (r) => (
        <>
          {r.job ? (
            <>
              <span className="mono">{r.job.number}</span>
              <div className="faint">{r.job.name}</div>
            </>
          ) : (
            <span className="faint">—</span>
          )}
        </>
      ),
    },
    { key: 'customer', label: 'Customer', render: (r) => r.customer.name },
    {
      key: 'billing',
      label: 'Billing · Sales order',
      render: (r) => (
        <>
          <span className="mono">{r.billing?.number ?? r.salesOrder.number}</span>
          <div className="faint mono">{r.billing ? r.salesOrder.number : 'from the sales order'}</div>
        </>
      ),
    },
    { key: 'amount', label: 'Net collectible', align: 'right', render: (r) => formatMoney(r.netCollectible) },
    { key: 'requestedBy', label: 'Requested by', render: (r) => r.requestedBy.name },
    { key: 'team', label: 'Team', render: (r) => r.team?.code ?? '—' },
    {
      key: 'status',
      label: 'Status',
      sortKey: 'status',
      render: (r) => (
        <>
          <StatusBadge status={r.status} extra={REQUEST_TONES} label={r.status === 'PENDING_APPROVAL' ? (r.stage ?? 'Back Support') : undefined} />
          {r.invoice && <div className="faint mono">{r.invoice.number}</div>}
        </>
      ),
    },
    { key: 'createdAt', label: 'Raised', sortKey: 'createdAt', render: (r) => formatDate(r.createdAt) },
  ];
  return (
    <div>
      <div className="page-head">
        <h1>Invoice Requests</h1>
      </div>
      <DataList<RequestRow>
        listKey="invoice-requests"
        endpoint="/invoice-requests"
        printPath="/api/invoice-requests/pdf"
        columns={columns}
        rowKey={(r) => r.id}
        scoped
        selectable
        searchPlaceholder="Search number, billing, sales order, project, customer, PO…"
        onRowClick={(r) => navigate(`/g-fin/invoice-requests/${r.id}`)}
        emptyTitle="No invoice requests"
        emptyHint="Ask for an invoice from an issued sales order, or from an approved progress billing on its project's Progress & Billing tab."
        filters={[
          { key: 'status', label: 'Status', options: STATUSES },
          { key: 'dateFrom', toKey: 'dateTo', label: 'Raised', type: 'dateRange' },
        ]}
        summary={(raw) => {
          const sum = raw as unknown as Summary | undefined;
          if (!sum) return null;
          return (
            <>
              <Stat
                label="Waiting for Back Support"
                value={String(sum.waiting)}
                figure
                accent={sum.waiting > 0 ? 'warn' : undefined}
                sub={`${formatMoney(sum.waitingValue)} net collectible`}
                to="/g-fin/invoice-requests?status=PENDING_APPROVAL"
              />
              <Stat label="Drafts" value={String(sum.drafts)} figure sub="not yet sent" to="/g-fin/invoice-requests?status=DRAFT" />
              <Stat label="Invoiced this month" value={String(sum.approvedThisMonth)} figure accent="ok" sub="approved, draft invoice raised" />
            </>
          );
        }}
      />
    </div>
  );
}

interface SourceOrder {
  id: string;
  number: string;
  poNumber: string | null;
  termsDays: number | null;
  net: number;
  invoiced: number;
  requested: number;
  left: number;
}

type Source =
  | {
      kind: 'billing';
      billing: { id: string; number: string; status: string; grossAmount: number; invoiceTotal: number; netCollectible: number };
      job: { id: string; number: string; name: string; customer: Named };
      customer: Named;
      problem: string | null;
      mayRequest: boolean;
      salesOrders: SourceOrder[];
    }
  | {
      kind: 'order';
      salesOrder: SourceOrder & { vatRate: number; subject: string | null };
      customer: Named;
      ewtRate: number;
      problem: string | null;
      mayRequest: boolean;
    };

export interface InvoiceRequestDetail {
  id: string;
  number: string;
  status: string;
  kind: 'billing' | 'order';
  job: { id: string; number: string; name: string } | null;
  customer: Named;
  description: string | null;
  progressBilling: {
    id: string;
    number: string;
    status: string;
    billingDate: string;
    report: { id: string; number: string; periodFrom: string; periodTo: string };
    lines: { id: string; name: string; previousPct: number; toDatePct: number; amount: number }[];
  } | null;
  grossAmount: number;
  vatRate: number;
  vatAmount: number;
  ewtRate: number;
  ewtAmount: number;
  invoiceTotal: number;
  netCollectible: number;
  salesOrder: { id: string; number: string; poNumber: string | null; net: number; invoiced: number; requested: number; left: number };
  invoiceDate: string | null;
  termsDays: number | null;
  terms: string;
  poReference: string | null;
  salesperson: Named | null;
  team: { id: string; code: string; name: string } | null;
  notes: string | null;
  requestedBy: Named;
  submittedAt: string | null;
  approvedAt: string | null;
  cancelReason: string | null;
  invoice: { id: string; number: string; status: string } | null;
  createdAt: string;
  canEdit: boolean;
  canSubmit: boolean;
  canWithdraw: boolean;
  canCancel: boolean;
  canDelete: boolean;
  approvalRoute: { name: string; steps: { name: string; held?: boolean; approvers: { id: string; name: string }[] }[] } | null;
}

const cents = (n: number) => Math.round(n * 100) / 100;

/**
 * "Request invoice" and Modify. From a billing: the sales order it is
 * invoiced on (the project's issued orders, with what is left of each). From
 * a sales order (2026-10-16, the owner's call): how much of the order to
 * invoice, before VAT — what is left by default — and the line's words. Either
 * way the invoice date, the terms and the customer's PO (the order's unless
 * typed). The sales personnel and team are the requester's — never typed.
 */
export function InvoiceRequestModal({
  billingId,
  salesOrderId,
  existing,
  onClose,
  onSaved,
}: {
  billingId?: string;
  salesOrderId?: string;
  existing?: InvoiceRequestDetail;
  onClose: () => void;
  onSaved: (saved: InvoiceRequestDetail) => void;
}) {
  const toast = useToast();
  const [source, setSource] = useState<Source | null>(null);
  const [form, setForm] = useState({
    salesOrderId: existing?.salesOrder.id ?? salesOrderId ?? '',
    invoiceDate: existing?.invoiceDate?.slice(0, 10) ?? '',
    termsDays: existing?.termsDays ?? 30,
    poReference: existing?.poReference ?? '',
    notes: existing?.notes ?? '',
    grossAmount: existing && existing.kind === 'order' ? existing.grossAmount : 0,
    description: existing?.description ?? '',
    /** The withholding rate picked; null takes the billing's, else the company's. */
    ewtRate: (existing ? existing.ewtRate : null) as number | null,
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const sourceKey = billingId ? `billingId=${billingId}` : `salesOrderId=${salesOrderId ?? existing?.salesOrder.id ?? ''}`;

  useEffect(() => {
    api
      .get<Source>(`/invoice-requests/source?${sourceKey}`)
      .then((s) => {
        setSource(s);
        if (existing) return;
        if (s.kind === 'billing' && s.salesOrders.length === 1) {
          // One order: it is the answer. Its PO and terms fill an empty form.
          const o = s.salesOrders[0];
          setForm((f) => ({ ...f, salesOrderId: o.id, poReference: f.poReference || o.poNumber || '', termsDays: o.termsDays ?? f.termsDays }));
        }
        if (s.kind === 'order') {
          const o = s.salesOrder;
          setForm((f) => ({
            ...f,
            salesOrderId: o.id,
            poReference: f.poReference || o.poNumber || '',
            termsDays: o.termsDays ?? f.termsDays,
            grossAmount: o.left,
            description: f.description || `Sales order ${o.number}${o.subject ? ` — ${o.subject}` : ''}`,
          }));
        }
      })
      .catch(setError);
  }, [sourceKey, existing]);

  const fromOrder = source?.kind === 'order';
  const order = !source ? null : source.kind === 'order' ? source.salesOrder : (source.salesOrders.find((o) => o.id === form.salesOrderId) ?? null);
  // A modified request's own ask is not counted against what is left.
  const left = order ? cents(order.left + (existing ? (existing.kind === 'order' ? existing.grossAmount : 0) : 0)) : 0;
  const gross = source?.kind === 'billing' ? source.billing.grossAmount : form.grossAmount;
  const over = !!order && gross > left + 0.005;
  const vatRate = source?.kind === 'order' ? source.salesOrder.vatRate : 0;
  // The source's own withholding rate: the order's company rate, or what the
  // billing carries (its invoice total less its net collectible, over its gross).
  const sourceEwt =
    source?.kind === 'order'
      ? source.ewtRate
      : source?.kind === 'billing' && source.billing.grossAmount > 0
        ? Math.round(((source.billing.invoiceTotal - source.billing.netCollectible) / source.billing.grossAmount) * 10000) / 10000
        : 0;
  const ewtRate = form.ewtRate ?? sourceEwt;
  const vat = cents(gross * vatRate);
  const ewt = cents(gross * ewtRate);

  function pickOrder(id: string) {
    if (source?.kind !== 'billing') return;
    const o = source.salesOrders.find((x) => x.id === id);
    setForm((f) => ({ ...f, salesOrderId: id, poReference: o?.poNumber ?? f.poReference, termsDays: o?.termsDays ?? f.termsDays }));
  }

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const body = {
        salesOrderId: form.salesOrderId,
        invoiceDate: form.invoiceDate || null,
        termsDays: form.termsDays,
        poReference: form.poReference || null,
        notes: form.notes || null,
        ewtRate: form.ewtRate,
        ...(fromOrder ? { grossAmount: form.grossAmount, description: form.description || null } : {}),
      };
      const saved = existing
        ? await api.put<InvoiceRequestDetail>(`/invoice-requests/${existing.id}`, body)
        : await api.post<InvoiceRequestDetail>('/invoice-requests', { ...body, progressBillingId: billingId ?? null });
      toast('ok', existing ? 'Saved' : `${saved.number} raised — submit it to Back Support`);
      onSaved(saved);
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  }

  const blocked = !existing && !!source?.problem;
  return (
    <Modal
      title={existing ? `Modify invoice request ${existing.number}` : 'New invoice request'}
      onClose={onClose}
      footer={
        <ModalFoot onCancel={onClose} busy={busy}>
          <button
            type="button"
            className="btn btn-primary"
            onClick={save}
            disabled={busy || !form.salesOrderId || over || blocked || (fromOrder && !(form.grossAmount > 0))}
          >
            {busy ? 'Saving…' : 'Save'}
          </button>
        </ModalFoot>
      }
    >
      <ErrorBox error={error} />
      {!source ? (
        <Loading />
      ) : (
        <>
          {blocked && <div className="alert warn">{source.problem}</div>}
          {!existing && !source.mayRequest && (
            <div className="alert warn">Only the salesperson who holds it, or their Team Leader, can ask for its invoice.</div>
          )}
          {source.kind === 'billing' ? (
            <>
              <dl className="kv">
                <dt>Billing</dt>
                <dd className="mono">{source.billing.number}</dd>
                <dt>Project</dt>
                <dd>
                  <span className="mono">{source.job.number}</span> {source.job.name}
                </dd>
                <dt>Customer</dt>
                <dd>{source.customer.name}</dd>
                <dt>Net collectible</dt>
                <dd>
                  {formatMoney(source.billing.netCollectible)} <span className="faint">({formatMoney(source.billing.grossAmount)} before VAT)</span>
                </dd>
              </dl>
              <Field
                label="Sales order"
                required
                hint={
                  source.salesOrders.length === 0
                    ? 'This project has no issued sales order — book its quotation as a sales order first.'
                    : order
                      ? `${formatMoney(left)} of ${formatMoney(order.net)} left to invoice (before VAT)`
                      : 'The order this billing is invoiced on.'
                }
                error={over ? `Only ${formatMoney(left)} of ${order!.number} is left — this billing is ${formatMoney(gross)}` : undefined}
              >
                <select value={form.salesOrderId} onChange={(e) => pickOrder(e.target.value)}>
                  <option value="">— choose —</option>
                  {source.salesOrders.map((o) => (
                    <option key={o.id} value={o.id}>
                      {o.number}
                      {o.poNumber ? ` · PO ${o.poNumber}` : ''} — {formatMoney(o.left)} left
                    </option>
                  ))}
                </select>
              </Field>
            </>
          ) : (
            <>
              <dl className="kv">
                <dt>Sales order</dt>
                <dd className="mono">{source.salesOrder.number}</dd>
                <dt>Customer</dt>
                <dd>{source.customer.name}</dd>
                <dt>Left to invoice</dt>
                <dd>
                  {formatMoney(left)} <span className="faint">of {formatMoney(source.salesOrder.net)} before VAT</span>
                  {source.salesOrder.requested > 0 && <div className="faint">{formatMoney(source.salesOrder.requested)} is already asked for in open requests</div>}
                </dd>
              </dl>
              <div className="grid-2">
                <Field
                  label="Amount to invoice (before VAT)"
                  required
                  error={over ? `Only ${formatMoney(left)} is left` : undefined}
                  hint={`VAT ${formatMoney(vat)} · total ${formatMoney(cents(gross + vat))} · net collectible ${formatMoney(cents(gross + vat - ewt))}`}
                >
                  <NumberInput kind="money" min={0} value={form.grossAmount} onChange={(e) => setForm((f) => ({ ...f, grossAmount: Number(e.target.value) }))} />
                </Field>
                <Field label="Invoice line" hint="What the invoice says it is for">
                  <input value={form.description} maxLength={500} onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))} />
                </Field>
              </div>
            </>
          )}
          <div className="grid-2">
            <Field label="Customer P.O." hint="The sales order's, unless typed">
              <input value={form.poReference} onChange={(e) => setForm((f) => ({ ...f, poReference: e.target.value }))} maxLength={120} />
            </Field>
            <Field label="Invoice date" hint="Blank: the day Back Support approves it">
              <input type="date" value={form.invoiceDate} onChange={(e) => setForm((f) => ({ ...f, invoiceDate: e.target.value }))} />
            </Field>
          </div>
          <Field label="Payment terms">
            <TermsPicker value={form.termsDays} onChange={(days) => setForm((f) => ({ ...f, termsDays: days }))} />
          </Field>
          <Field label="Withholding tax (EWT)" hint={`Withheld by the customer on the amount before VAT — ${formatMoney(cents(gross * ewtRate))}`}>
            <EwtPicker value={ewtRate} onChange={(rate) => setForm((f) => ({ ...f, ewtRate: rate }))} />
          </Field>
          <Field label="Notes for Back Support and finance">
            <textarea rows={2} value={form.notes} onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))} />
          </Field>
          <p className="faint">The invoice is credited to you and your team, as the one asking for it.</p>
        </>
      )}
    </Modal>
  );
}

/** `/g-fin/invoice-requests/:id` — where the approval notification lands. No web Guard: the API decides. */
export function InvoiceRequestPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const toast = useToast();
  const { can } = useAuth();
  const confirm = useConfirm();
  const [row, setRow] = useState<InvoiceRequestDetail | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [reload, setReload] = useState(0);
  const [editing, setEditing] = useState(false);

  const load = useCallback(async () => {
    try {
      setRow(await api.get<InvoiceRequestDetail>(`/invoice-requests/${id}`));
    } catch (err) {
      setError(err);
    }
  }, [id]);

  useEffect(() => {
    load();
  }, [load]);

  if (error && !row) return <ErrorBox error={error} />;
  if (!row) return <Loading />;

  const draft = row.status === 'DRAFT';
  const route = row.approvalRoute;
  const done = () => {
    setReload((r) => r + 1);
    load();
  };

  async function submit() {
    setError(null);
    try {
      await api.post(`/invoice-requests/${id}/submit`);
      toast('ok', 'Sent to Back Support');
      done();
    } catch (err) {
      setError(err);
    }
  }

  return (
    <div>
      <RecordHeader
        type="Invoice Request"
        code={row.number}
        title={row.progressBilling ? `${row.progressBilling.number} on ${row.salesOrder.number}` : (row.description ?? `Sales order ${row.salesOrder.number}`)}
        status={row.status}
        statusExtra={REQUEST_TONES}
        amount={formatMoney(row.netCollectible)}
        amountLabel="Net collectible"
        meta={
          <>
            Requested by {row.requestedBy.name} on {formatDate(row.createdAt)} · {row.customer.name}
            {row.job && (
              <>
                {' · '}
                {can('gops.projects.view_all') || can('gops.projects.view_own') ? (
                  <Link to={`/g-ops/projects/${row.job.id}?tab=progress`} className="mono">
                    {row.job.number}
                  </Link>
                ) : (
                  <span className="mono">{row.job.number}</span>
                )}{' '}
                {row.job.name}
              </>
            )}
          </>
        }
        actions={
          row.canSubmit ? (
            <button className="btn btn-primary" onClick={submit}>
              Submit for approval
            </button>
          ) : row.invoice && can('gfin.ar.view_all') ? (
            <Link className="btn btn-primary" to={`/g-fin/ar/${row.invoice.id}`}>
              Open invoice {row.invoice.number}
            </Link>
          ) : undefined
        }
        print={`/api/invoice-requests/${row.id}/pdf`}
        more={[
          row.canWithdraw && {
            label: 'Pull back to draft',
            confirm: {
              title: `Pull ${row.number} back?`,
              body: 'The approval request is withdrawn and Back Support is told. It comes back as a draft to change and send again.',
              confirmLabel: 'Pull it back',
              onConfirm: async () => {
                await api.post(`/invoice-requests/${row.id}/withdraw`);
                toast('ok', 'Back to draft');
                done();
              },
            },
          },
          row.canCancel && {
            label: 'Cancel request',
            danger: true,
            confirm: {
              title: `Cancel ${row.number}?`,
              body: row.status === 'PENDING_APPROVAL' ? 'The approval request is withdrawn with it, and Back Support is told.' : 'Nothing has been decided yet.',
              confirmLabel: 'Cancel request',
              reason: 'required',
              reasonLabel: 'Why? Kept on the request',
              minReason: 3,
              onConfirm: async (reason) => {
                await api.post(`/invoice-requests/${row.id}/cancel`, { reason });
                toast('ok', 'Cancelled');
                done();
              },
            },
          },
          row.canDelete && {
            label: 'Delete',
            danger: true,
            confirm: {
              title: `Delete ${row.number}?`,
              body: 'It goes for good, with its files. Its number is not reused.',
              confirmLabel: 'Delete',
              onConfirm: async () => {
                await api.del(`/invoice-requests/${row.id}`);
                toast('ok', 'Deleted');
                navigate('/g-fin/invoice-requests');
              },
            },
          },
        ]}
        modify={row.canEdit ? () => setEditing(true) : undefined}
        confirm={confirm}
      />

      {draft && route && route.steps.length > 0 && (
        <div className="qd-route">
          <span className="qd-route-label">Submit for approval sends it to</span>
          <ApprovalStepper steps={previewSteps(route)} />
        </div>
      )}
      <DecisionNote documentType="invoice_request" documentId={row.id} reloadToken={reload} />
      {!draft && row.status !== 'CANCELLED' && <DocumentApproval documentType="invoice_request" documentId={row.id} reloadToken={reload} />}

      <ErrorBox error={error} />

      {draft && <div className="alert info">A draft. Back Support's approval raises the draft invoice in Accounts Receivable.</div>}
      {row.status === 'APPROVED' && row.invoice && (
        <div className="alert ok">
          Approved{row.approvedAt ? ` on ${formatDate(row.approvedAt)}` : ''} — draft invoice {row.invoice.number} raised in Accounts Receivable
          {row.invoice.status !== 'DRAFT' ? ` (now ${row.invoice.status.toLowerCase().replace(/_/g, ' ')})` : ', for finance to issue'}.
        </div>
      )}
      {row.status === 'CANCELLED' && <div className="alert warn">Cancelled{row.cancelReason ? ` — ${row.cancelReason}` : ''}.</div>}

      <div className="stack">
        <div className="grid-2">
          <section className="card">
            <h3 className="card-title">What is to be invoiced</h3>
            <dl className="kv">
              {row.progressBilling && (
                <>
                  <dt>Billing</dt>
                  <dd>
                    <Link to={`/g-ops/billings/${row.progressBilling.id}`} className="mono">
                      {row.progressBilling.number}
                    </Link>{' '}
                    <span className="faint">
                      {formatDate(row.progressBilling.report.periodFrom)} – {formatDate(row.progressBilling.report.periodTo)}
                    </span>
                  </dd>
                </>
              )}
              <dt>Sales order</dt>
              <dd>
                <Link to={`/g-ops/sales-orders/${row.salesOrder.id}`} className="mono">
                  {row.salesOrder.number}
                </Link>{' '}
                <span className="faint">{formatMoney(row.salesOrder.left)} of {formatMoney(row.salesOrder.net)} left</span>
              </dd>
              <dt>Customer P.O.</dt>
              <dd>{row.poReference ?? '—'}</dd>
              <dt>Payment terms</dt>
              <dd>{row.terms || '—'}</dd>
              <dt>Invoice date</dt>
              <dd>{row.invoiceDate ? formatDate(row.invoiceDate) : 'The day it is approved'}</dd>
              <dt>Sales personnel</dt>
              <dd>{row.salesperson?.name ?? '—'}</dd>
              <dt>Team</dt>
              <dd>{row.team ? `${row.team.code} — ${row.team.name}` : '—'}</dd>
              {row.notes && (
                <>
                  <dt>Notes</dt>
                  <dd className="del-prose">{row.notes}</dd>
                </>
              )}
            </dl>
          </section>
          <section className="card">
            <h3 className="card-title">{row.progressBilling ? "The money (the billing's, never re-keyed)" : 'The money'}</h3>
            <dl className="kv">
              <dt>Gross</dt>
              <dd>{formatMoney(row.grossAmount)}</dd>
              <dt>VAT ({(row.vatRate * 100).toFixed(0)}%)</dt>
              <dd>{formatMoney(row.vatAmount)}</dd>
              <dt>Invoice total</dt>
              <dd>{formatMoney(row.invoiceTotal)}</dd>
              <dt>Less: EWT ({(row.ewtRate * 100).toFixed(0)}%)</dt>
              <dd>({formatMoney(row.ewtAmount)})</dd>
              <dt>Net collectible</dt>
              <dd>
                <b>{formatMoney(row.netCollectible)}</b>
              </dd>
            </dl>
          </section>
        </div>

        <section className="card">
          <h3 className="card-title">Particulars</h3>
          <div className="table-wrap">
            {row.progressBilling ? (
              <table className="data">
                <thead>
                  <tr>
                    <th>Scope of work</th>
                    <th className="num">Previous</th>
                    <th className="num">To date</th>
                    <th className="num">Amount</th>
                  </tr>
                </thead>
                <tbody>
                  {row.progressBilling.lines.map((l) => (
                    <tr key={l.id}>
                      <td>{l.name}</td>
                      <td className="num">{l.previousPct.toFixed(2)}%</td>
                      <td className="num">{l.toDatePct.toFixed(2)}%</td>
                      <td className="num">{formatMoney(l.amount)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <table className="data">
                <thead>
                  <tr>
                    <th>Description</th>
                    <th className="num">Amount (before VAT)</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td>
                      {row.description ?? `Sales order ${row.salesOrder.number}`}
                      <div className="faint">Sales order {row.salesOrder.number}</div>
                    </td>
                    <td className="num">{formatMoney(row.grossAmount)}</td>
                  </tr>
                </tbody>
              </table>
            )}
          </div>
        </section>

        <Attachments
          entityType="invoice_request"
          entityId={row.id}
          title="Files"
          hint={draft ? 'The customer’s PO, an acceptance — printed behind the request.' : 'What Back Support was sent. Files change only on a draft.'}
          canEdit={!!row.canEdit}
        />
      </div>

      {editing && (
        <InvoiceRequestModal
          billingId={row.progressBilling?.id}
          salesOrderId={row.salesOrder.id}
          existing={row}
          onClose={() => setEditing(false)}
          onSaved={() => {
            setEditing(false);
            done();
          }}
        />
      )}
    </div>
  );
}
