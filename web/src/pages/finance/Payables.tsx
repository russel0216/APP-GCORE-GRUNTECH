import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { DataList, type Column } from '../../components/DataList';
import { RecordHeader } from '../../components/RecordHeader';
import { useConfirm } from '../../components/Confirm';
import { DocumentApproval, DecisionNote } from '../../components/ApprovalStepper';
import {
  Checkbox,
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
import { RecordPaymentModal, CellLink, paymentLink, TermsPicker } from './Receivables';
import { Stat } from '../../components/charts';
import { PersonSelect, usePeople } from '../../components/People';
import type { FilterDef } from '../../components/DataList';
import { qs } from '../../lib/api';
import { todayLocal } from '../../lib/day';
import { NumberInput } from '../../components/NumberInput';
import { SupplierPicker, type SupplierRef } from '../../components/SupplierPicker';

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
  /** Edit All, or Edit Own on a bill the viewer entered (2026-10-18) — the API's word. */
  canEdit?: boolean;
  number: string;
  status: string;
  supplierInvoiceNo: string | null;
  billDate: string;
  dueDate: string;
  terms: string | null;
  deliveryDate: string | null;
  termsDays: number | null;
  termsLabel: string;
  purchaser: { id: string; name: string } | null;
  /** A purchaser with no login, typed by name. */
  purchaserName?: string | null;
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

interface PayablesSummary {
  payable: number;
  payableCount: number;
  pendingCount: number;
  pending: number;
  dueSoon: number;
  dueSoonCount: number;
  dueSoonDays: number;
  overdue: number;
  overdueCount: number;
}

/** The terms the A/P form offers as chips, and the filter's choices. */
const BILL_TERMS = [7, 15, 30, 45, 60];
const termsWords = (d: number) => (d === 0 ? 'On delivery' : `${d} Day${d === 1 ? '' : 's'}`);

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
  const toast = useToast();
  const [params, setParams] = useSearchParams();
  const [queue, setQueue] = useState<UnbilledReceiving[] | null>(null);
  const [creating, setCreating] = useState<UnbilledReceiving | 'blank' | null>(null);
  const [reload, setReload] = useState(0);
  const fromReceiving = params.get('fromReceiving');

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

  function clearHandoff() {
    if (!params.has('fromReceiving')) return;
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.delete('fromReceiving');
        return next;
      },
      { replace: true },
    );
  }

  /*
    `?fromReceiving=<id>` — the receiving's "Enter supplier bill" lands here.
    It opens the same form as the queue's "Enter bill", taken from the queue
    so the figures are the ones the queue would have offered. A receiving that
    is not in the queue has been billed already (or is not ours to bill), and
    saying so beats opening a blank form that would bill it twice.
  */
  useEffect(() => {
    if (!fromReceiving || !queue) return;
    const match = queue.find((r) => r.id === fromReceiving);
    if (match && can('gfin.ap.create')) setCreating(match);
    else if (!match) toast('error', 'That receiving is not waiting on a bill — it may already have one');
    clearHandoff();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fromReceiving, queue]);

  const { people: buyers } = usePeople('gchain.purchase_orders.create');

  const columns: Column<Bill>[] = [
    {
      key: 'number',
      label: 'Bill No.',
      sortKey: 'number',
      width: '160px',
      render: (r) => (
        <div>
          <span className="mono">{r.number}</span>
          {r.supplierInvoiceNo && <div className="faint mono">{r.supplierInvoiceNo}</div>}
        </div>
      ),
    },
    {
      key: 'supplier',
      label: 'Company / Vendor',
      render: (r) => (
        <div>
          <div>
            <CellLink to={`/g-chain/suppliers/${r.supplier.id}`}>{r.supplier.name}</CellLink>
          </div>
          <div className="faint">
            {r.job ? `${r.job.number} — ${r.job.name}` : r.order ? `Order ${r.order.number}` : 'No project'}
            {r.receiving && (
              <>
                {' · '}
                <CellLink to={`/g-chain/incoming/${r.receiving.id}`} className="mono">
                  {r.receiving.number}
                </CellLink>
              </>
            )}
          </div>
        </div>
      ),
    },
    {
      key: 'netPayable',
      label: 'Amount',
      align: 'right',
      render: (r) => (
        <div>
          <div className="mono">{formatMoney(r.netPayable)}</div>
          {r.status === 'PAID' ? (
            <div className="faint">paid</div>
          ) : r.outstanding > 0 && (r.status === 'APPROVED' || r.status === 'PARTIALLY_PAID') && r.outstanding < r.netPayable ? (
            <div className="faint">{formatMoney(r.outstanding)} left</div>
          ) : r.ewtAmount > 0 ? (
            <div className="faint">less {formatMoney(r.ewtAmount)} withheld</div>
          ) : null}
        </div>
      ),
    },
    {
      key: 'deliveryDate',
      label: 'Date of delivery',
      sortKey: 'deliveryDate',
      render: (r) => (r.deliveryDate ? formatDate(r.deliveryDate) : <span className="faint">—</span>),
    },
    {
      key: 'terms',
      label: 'Payment terms',
      render: (r) => <span className="badge">{r.termsLabel}</span>,
    },
    {
      key: 'dueDate',
      label: 'Due date',
      sortKey: 'dueDate',
      render: (r) => (
        <div>
          <div>{formatDate(r.dueDate)}</div>
          {r.outstanding > 0 && r.daysOverdue > 0 && (r.status === 'APPROVED' || r.status === 'PARTIALLY_PAID') && (
            <div className="faint warn">{r.daysOverdue} days late</div>
          )}
        </div>
      ),
    },
    {
      key: 'purchaser',
      label: 'Purchaser / Buyer',
      render: (r) => r.purchaser?.name ?? r.purchaserName ?? <span className="faint">—</span>,
    },
    {
      key: 'status',
      label: 'Status',
      render: (r) => <StatusBadge status={r.status} />,
    },
    { key: 'billDate', label: 'Bill date', sortKey: 'billDate', optional: true, render: (r) => formatDate(r.billDate) },
    {
      key: 'total',
      label: 'Billed',
      align: 'right',
      optional: true,
      render: (r) => <span className="mono faint">{formatMoney(r.total)}</span>,
    },
    {
      key: 'posted',
      label: 'Job cost',
      optional: true,
      render: (r) =>
        r.postedToJob ? (
          <span title="This bill was the first time that cost appeared">
            <StatusBadge status="CHARGED" extra={{ CHARGED: 'ok' }} label="charged" />
          </span>
        ) : r.receiving ? (
          <span title={`${r.receiving.number} already incurred it`}>
            <StatusBadge status="INCURRED" extra={{ INCURRED: '' }} label="already incurred" />
          </span>
        ) : (
          <span className="faint">—</span>
        ),
    },
  ];

  const filters: FilterDef[] = [
    { key: 'status', label: 'Status', options: BILL_STATUSES },
    { key: 'outstanding', label: 'Balance', options: [{ value: 'true', label: 'Outstanding only' }] },
    { key: 'overdue', label: 'Overdue', options: [{ value: 'true', label: 'Overdue only' }] },
    { key: 'dueSoon', label: 'Due soon', options: [{ value: 'true', label: 'Due in the next 7 days' }] },
    { key: 'pending', label: 'Pending', options: [{ value: 'true', label: 'Draft or pending approval' }] },
    {
      key: 'purchaserId',
      label: 'Purchaser / Buyer',
      options: [{ value: 'none', label: 'Nobody named' }, ...buyers.map((p) => ({ value: p.id, label: p.name }))],
    },
    {
      key: 'supplierId',
      label: 'Supplier / Vendor',
      type: 'lookup',
      placeholder: 'Type a supplier name…',
      search: async (term: string) =>
        (await api.get<{ id: string; code: string; name: string }[]>(`/suppliers/lookup${qs({ q: term })}`)).map((c) => ({
          value: c.id,
          label: `${c.name} · ${c.code}`,
        })),
      describe: async (id: string) => {
        const c = await api.get<{ name: string; code: string }>(`/suppliers/${id}`);
        return `${c.name} · ${c.code}`;
      },
    },
    { key: 'termsDays', label: 'Payment terms', options: [0, ...BILL_TERMS].map((d) => ({ value: String(d), label: termsWords(d) })) },
    { key: 'dueFrom', toKey: 'dueTo', label: 'Due date', type: 'dateRange' },
    { key: 'deliveredFrom', toKey: 'deliveredTo', label: 'Date of delivery', type: 'dateRange' },
  ];

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Accounts Payable</h1>
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
                      <Link to={`/g-chain/incoming/${r.id}`} className="mono">
                        {r.number}
                      </Link>
                      <div className="faint">{formatDate(r.receivedDate)}</div>
                    </td>
                    <td>
                      <Link to={`/g-chain/suppliers/${r.order.supplier.id}`}>{r.order.supplier.name}</Link>
                    </td>
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
        printPath="/api/supplier-bills/pdf"
        reportPath="/g-fin/reports?kind=payables"
        menuItems={[{ label: 'Payables aging', onSelect: () => navigate('/g-fin/reports?kind=payables-aging') }]}
        columns={columns}
        rowKey={(r) => r.id}
        reloadToken={reload}
        selectable
        summary={(raw) => {
          const sum = raw as unknown as PayablesSummary | undefined;
          if (!sum) return null;
          return (
            <>
              <Stat
                label="Sum of all payables"
                value={formatMoney(sum.payable)}
                figure
                sub={`${sum.payableCount} approved bill${sum.payableCount === 1 ? '' : 's'} to pay`}
                to="/g-fin/ap?outstanding=true"
              />
              <Stat
                label="Pending bills"
                value={String(sum.pendingCount)}
                sub={`${formatMoney(sum.pending)} draft or awaiting approval`}
                to="/g-fin/ap?pending=true"
              />
              <Stat
                label={`Due in ${sum.dueSoonDays} days`}
                value={formatMoney(sum.dueSoon)}
                figure
                accent={sum.dueSoon > 0 ? 'warn' : undefined}
                sub={`${sum.dueSoonCount} bill${sum.dueSoonCount === 1 ? '' : 's'}`}
                to="/g-fin/ap?dueSoon=true"
              />
              <Stat
                label="Overdue"
                value={formatMoney(sum.overdue)}
                figure
                accent={sum.overdue > 0 ? 'warn' : undefined}
                sub={`${sum.overdueCount} past the due date`}
                to="/g-fin/ap?overdue=true"
              />
            </>
          );
        }}
        searchPlaceholder="Search bill no., supplier, their invoice, purchaser, PO…"
        emptyTitle="No supplier bills yet"
        emptyHint="A bill matched to a receiving charges the project nothing further; one with nothing received behind it is charged when approved."
        onRowClick={(r) => navigate(`/g-fin/ap/${r.id}`)}
        filters={filters}
        actions={
          can('gfin.ap.create') ? (
            <button className="btn btn-primary btn-sm" onClick={() => setCreating('blank')}>
              + New supplier bill
            </button>
          ) : null
        }
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

/** Whole days from one stored date to another — a bill's terms, read back off its dates. */
function daysFrom(from: string, to: string): number {
  const ms = Date.parse(`${to.slice(0, 10)}T00:00:00Z`) - Date.parse(`${from.slice(0, 10)}T00:00:00Z`);
  return Number.isFinite(ms) ? Math.max(0, Math.round(ms / 86_400_000)) : 0;
}

/**
 * Entering a supplier bill — blank, or from a receiving in the queue — or,
 * with `existing`, modifying a draft one (`PUT /supplier-bills/:id`). A bill
 * against an order keeps its order and receiving: that receiving is what
 * stops approval charging the project a second time.
 */
function NewBillModal({
  from,
  existing,
  onClose,
  onCreated,
}: {
  from: UnbilledReceiving | null;
  /** A draft bill to modify. */
  existing?: Bill;
  onClose: () => void;
  onCreated: (id: string) => void;
}) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [jobs, setJobs] = useState<{ id: string; number: string; name: string }[]>([]);
  const [categories, setCategories] = useState<{ id: string; name: string }[]>([]);
  const [settings, setSettings] = useState<{
    defaultTermsDays: number;
    supplierEwtGoods: number;
    supplierEwtServices: number;
    vatRate: number;
  } | null>(null);

  const today = todayLocal();
  // A bill entered VAT-inclusive stores its lines as typed and its subtotal
  // with the VAT backed out — so the two differ exactly when it was.
  const existingLineTotal = existing ? existing.lines.reduce((s, l) => s + l.amount, 0) : 0;
  // The draft's own supplier, or the order's behind the receiving; else picked.
  const [supplier, setSupplier] = useState<SupplierRef | null>(
    existing
      ? { id: existing.supplier.id, name: existing.supplier.name }
      : from
        ? { id: from.order.supplier.id, name: from.order.supplier.name }
        : null,
  );
  const [form, setForm] = useState({
    jobId: existing?.job?.id ?? from?.order.job?.id ?? '',
    costCategoryId: existing?.costCategory?.id ?? '',
    supplierInvoiceNo: existing?.supplierInvoiceNo ?? from?.invoiceRefNo ?? '',
    billDate: existing?.billDate.slice(0, 10) ?? today,
    // The receiving's date, else typed: the terms run from it.
    deliveryDate: existing?.deliveryDate?.slice(0, 10) ?? from?.receivedDate.slice(0, 10) ?? '',
    terms: existing ? existing.termsDays ?? daysFrom(existing.billDate, existing.dueDate) : 30,
    purchaserId: existing?.purchaser?.id ?? '',
    // A purchaser with no login is typed (2026-10-16, the owner's call).
    purchaserName: existing?.purchaserName ?? '',
    typingPurchaser: !!existing?.purchaserName,
    vatInclusive: existing ? Math.abs(existing.subtotal - existingLineTotal) > 0.005 : false,
    ewtRate: existing?.ewtRate ?? 0,
    notes: existing?.notes ?? '',
  });
  const [lines, setLines] = useState(
    existing
      ? existing.lines.map((l) => ({ description: l.description, quantity: l.quantity, unitPrice: l.unitPrice }))
      : [
          {
            description: from ? `Goods received on ${from.number}` : '',
            quantity: 1,
            unitPrice: from?.receivedValue ?? 0,
          },
        ],
  );
  // What the bill is matched to: the queue's receiving, or the draft's own.
  const matchedTo = from?.number ?? existing?.receiving?.number ?? null;
  const onOrder = !!from || !!existing?.order;

  useEffect(() => {
    api.get<typeof jobs>('/jobs/lookup?includeClosed=true').then(setJobs).catch(() => {});
    api.get<{ id: string; name: string }[]>('/reference/cost-categories').then(setCategories).catch(() => {});
    api
      .get<{ defaultTermsDays: number; supplierEwtGoods: number; supplierEwtServices: number; vatRate: number }>(
        '/finance-settings',
      )
      .then((s) => {
        setSettings(s);
        // A draft keeps the terms its own dates say.
        if (!existing) setForm((f) => ({ ...f, terms: s.defaultTermsDays }));
      })
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // A draft keeps the VAT rate it was entered with; a new bill takes today's.
  const vatRate = existing?.vatRate ?? settings?.vatRate ?? 0.12;
  const goodsRate = settings?.supplierEwtGoods ?? 0.01;
  const servicesRate = settings?.supplierEwtServices ?? 0.02;
  // A rate the settings no longer offer stays choosable on the draft that has it.
  const otherRate = form.ewtRate > 0 && form.ewtRate !== goodsRate && form.ewtRate !== servicesRate ? form.ewtRate : null;
  const lineTotal = lines.reduce((s, l) => s + l.quantity * l.unitPrice, 0);
  const subtotal = form.vatInclusive ? lineTotal / (1 + vatRate) : lineTotal;
  const vatAmount = subtotal * vatRate;
  const total = subtotal + vatAmount;
  const ewtAmount = subtotal * form.ewtRate;
  const netPayable = total - ewtAmount;

  const { people: buyers } = usePeople('gchain.purchase_orders.create');
  const dueDate = (() => {
    const d = new Date(`${form.deliveryDate || form.billDate}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + form.terms);
    return d.toISOString().slice(0, 10);
  })();

  async function create() {
    if (!supplier) return;
    setBusy(true);
    setError(null);
    try {
      const body = {
        supplierId: supplier.id,
        orderId: existing ? existing.order?.id ?? null : from?.order.id ?? null,
        receivingId: existing ? existing.receiving?.id ?? null : from?.id ?? null,
        jobId: form.jobId || null,
        costCategoryId: form.costCategoryId || null,
        supplierInvoiceNo: form.supplierInvoiceNo || null,
        billDate: form.billDate,
        deliveryDate: form.deliveryDate || null,
        termsDays: form.terms,
        // Left empty on a bill against an order, the order's author is the purchaser.
        purchaserId: form.typingPurchaser ? null : form.purchaserId || null,
        purchaserName: form.typingPurchaser ? form.purchaserName.trim() || null : null,
        ...(existing ? { vatRate: existing.vatRate } : {}),
        vatInclusive: form.vatInclusive,
        ewtRate: form.ewtRate,
        notes: form.notes || null,
        lines: lines.filter((l) => l.description.trim() && l.unitPrice !== 0),
      };
      const saved = existing
        ? await api.put<{ id: string }>(`/supplier-bills/${existing.id}`, body)
        : await api.post<{ id: string }>('/supplier-bills', body);
      toast('ok', existing ? 'Saved' : 'Bill entered — submit it for approval next');
      onCreated(saved.id);
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  }

  return (
    <Modal
      title={
        existing
          ? `Modify supplier bill ${existing.number}`
          : from
            ? `New supplier bill for ${from.number}`
            : 'New supplier bill'
      }
      onClose={onClose}
      wide
      footer={
        <ModalFoot onCancel={onClose} busy={busy}>
          <button
            className="btn btn-primary"
            onClick={create}
            disabled={busy || !supplier || lineTotal <= 0}
          >
            {busy ? 'Saving…' : 'Save'}
          </button>
        </ModalFoot>
      }
    >
      <ErrorBox error={error} />

      {matchedTo ? (
        <div className="alert info">
          This bill is matched to <span className="mono">{matchedTo}</span>. The goods were
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
        <Field label="Supplier" required>
          {/* The order fixes the supplier. */}
          <SupplierPicker
            value={supplier}
            onChange={setSupplier}
            onError={setError}
            disabled={onOrder}
            autoFocus={!onOrder}
          />
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
        <Field
          label="Date of delivery"
          hint={matchedTo ? `Received on ${matchedTo}` : 'When the goods or the work were delivered — the terms run from it'}
        >
          <input
            type="date"
            value={form.deliveryDate}
            onChange={(e) => setForm({ ...form, deliveryDate: e.target.value })}
          />
        </Field>
      </div>

      <div className="grid grid-2">
        <Field label="Payment terms" hint={`Due ${formatDate(dueDate)} — the ${form.deliveryDate ? 'delivery' : 'bill date'} plus the terms`}>
          <TermsPicker value={form.terms} onChange={(d) => setForm({ ...form, terms: d })} />
        </Field>
        <Field
          label="Purchaser / Buyer"
          hint={
            <>
              {form.typingPurchaser
                ? 'Someone with no login, by name. '
                : onOrder && !form.purchaserId
                  ? "Left empty, the order's author. "
                  : ''}
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={() => setForm({ ...form, typingPurchaser: !form.typingPurchaser })}
              >
                {form.typingPurchaser ? 'Pick from the list' : 'Not on the list? Type a name'}
              </button>
            </>
          }
        >
          {form.typingPurchaser ? (
            <input
              value={form.purchaserName}
              maxLength={120}
              placeholder="The purchaser's name"
              onChange={(e) => setForm({ ...form, purchaserName: e.target.value })}
            />
          ) : (
            <PersonSelect
              value={form.purchaserId}
              onChange={(id) => setForm({ ...form, purchaserId: id })}
              people={buyers}
              current={existing?.purchaser ?? null}
              placeholder={onOrder ? "— the order's author —" : '— none —'}
            />
          )}
        </Field>
      </div>

      <div className="grid grid-2">
        <Field label="Project" hint={onOrder ? 'Carried from the order' : 'Leave empty for overheads'}>
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

      <h4 className="fin-section-title">Lines</h4>
      <div className="table-wrap">
        <table className="data">
          <thead>
            <tr>
              <th>Description</th>
              <th className="right">Qty</th>
              <th className="right">Unit price</th>
              <th className="right">Amount</th>
              <th className="right">VAT ({(vatRate * 100).toFixed(0)}%)</th>
              <th className="right">Amount incl. VAT</th>
              <th className="fin-col-tight" />
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
                  <NumberInput
                    kind="quantity"
                    step="0.01"
                    value={l.quantity}
                    onChange={(e) => {
                      const next = [...lines];
                      next[i] = { ...l, quantity: Number(e.target.value) };
                      setLines(next);
                    }}
                    className="fin-amount-input"
                  />
                </td>
                <td>
                  <NumberInput
                    kind="money"
                    step="0.01"
                    value={l.unitPrice}
                    onChange={(e) => {
                      const next = [...lines];
                      next[i] = { ...l, unitPrice: Number(e.target.value) };
                      setLines(next);
                    }}
                    className="fin-amount-input"
                  />
                </td>
                <td className="right mono">{formatMoney(l.quantity * l.unitPrice)}</td>
                {/* Each line's VAT and amount with VAT (2026-10-16): backed out
                    of the line when their prices include it, added otherwise. */}
                {(() => {
                  const amount = l.quantity * l.unitPrice;
                  const incl = form.vatInclusive ? amount : amount * (1 + vatRate);
                  const vat = form.vatInclusive ? amount - amount / (1 + vatRate) : amount * vatRate;
                  return (
                    <>
                      <td className="right mono">{formatMoney(vat)}</td>
                      <td className="right mono">{formatMoney(incl)}</td>
                    </>
                  );
                })()}
                <td className="right">
                  {lines.length > 1 && (
                    <button
                      className="btn btn-ghost btn-sm"
                      aria-label={`Remove line ${i + 1}`}
                      onClick={() => setLines(lines.filter((_, j) => j !== i))}
                    >
                      Remove
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <button
        className="btn btn-sm fin-gap-top-sm"
        onClick={() => setLines([...lines, { description: '', quantity: 1, unitPrice: 0 }])}
      >
        + Add line
      </button>

      <div className="grid grid-2 fin-gap-top">
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
              <option value={goodsRate}>Goods — {(goodsRate * 100).toFixed(0)}%</option>
              <option value={servicesRate}>Services / subcontract — {(servicesRate * 100).toFixed(0)}%</option>
              {otherRate !== null && <option value={otherRate}>As entered — {(otherRate * 100).toFixed(2)}%</option>}
            </select>
          </Field>
          <Field label="Notes">
            <textarea rows={2} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
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
  const toast = useToast();
  const { can } = useAuth();
  const [row, setRow] = useState<Bill | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [paying, setPaying] = useState(false);
  const [editing, setEditing] = useState(false);
  // Bumped after a submit, so the approval chain under the header shows the new request.
  const [reload, setReload] = useState(0);
  const confirm = useConfirm();

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

  if (error && !row) return <ErrorBox error={error} />;
  if (!row) return <Loading />;

  async function submit() {
    try {
      await api.post(`/supplier-bills/${id}/submit`);
      toast('ok', 'Submitted for approval');
      setReload((r) => r + 1);
      load();
    } catch (err) {
      setError(err);
    }
  }

  // Thrown, not caught: the confirm bar shows the refusal and stays open.
  async function cancel(reason: string) {
    await api.post(`/supplier-bills/${id}/cancel`, { reason });
    toast('ok', 'Cancelled');
    await load();
  }

  // Both mirror the routes: a draft, by whoever may edit this bill — Edit
  // All, or Edit Own on one the viewer entered (2026-10-18, `canEdit`).
  const canModify = row.status === 'DRAFT' && !!row.canEdit;
  const canCancel = row.status === 'DRAFT' && !!row.canEdit;

  return (
    <div>
      <RecordHeader
        type="Supplier Bill"
        code={row.number}
        title={row.supplier.name}
        status={row.status}
        amount={formatMoney(row.netPayable)}
        // What leaves the bank, after whatever Gruntech withholds.
        amountLabel="Net payable"
        meta={
          <>
            <Link to={`/g-chain/suppliers/${row.supplier.id}`}>{row.supplier.name}</Link>
            {row.supplierInvoiceNo && <> · their ref {row.supplierInvoiceNo}</>}
            {row.job && (
              <>
                {' · '}
                <Link to={`/g-ops/projects/${row.job.id}`} className="mono">
                  {row.job.number}
                </Link>{' '}
                {row.job.name}
              </>
            )}
          </>
        }
        actions={
          <>
            {row.status === 'DRAFT' && can('gfin.ap.create') && (
              <button className="btn btn-primary" onClick={submit}>
                Submit for approval
              </button>
            )}
            {(row.status === 'APPROVED' || row.status === 'PARTIALLY_PAID') && can('gfin.ap.create') && (
              <button className="btn btn-primary" onClick={() => setPaying(true)}>
                Record payment
              </button>
            )}
          </>
        }
        more={[
          canCancel && {
            label: 'Cancel bill',
            danger: true,
            confirm: {
              title: `Cancel ${row.number}?`,
              body: 'Nothing has been approved, charged or paid on it. The reason is kept on its notes.',
              confirmLabel: 'Cancel bill',
              reason: 'required',
              reasonLabel: 'Why?',
              minReason: 3,
              onConfirm: cancel,
            },
          },
        ]}
        modify={canModify ? () => setEditing(true) : undefined}
        confirm={confirm}
      />

      <DecisionNote documentType="supplier_bill" documentId={row.id} reloadToken={reload} />
      <DocumentApproval documentType="supplier_bill" documentId={row.id} reloadToken={reload} />

      <ErrorBox error={error} />

      {row.receiving ? (
        <div className="alert info">
          Matched to{' '}
          <Link to={`/g-chain/incoming/${row.receiving.id}`} className="mono">
            {row.receiving.number}
          </Link>
          , received{' '}
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

          <dl className="kv fin-gap-top">
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
              <dt>Date of delivery</dt>
              <dd>{row.deliveryDate ? formatDate(row.deliveryDate) : '—'}</dd>
              <dt>Payment terms</dt>
              <dd>{row.termsLabel}</dd>
              <dt>Purchaser / Buyer</dt>
              <dd>{row.purchaser?.name ?? row.purchaserName ?? '—'}</dd>
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
              {row.notes && (
                <>
                  <dt>Notes</dt>
                  <dd>
                    {row.notes.split('\n').map((line, i) => (
                      <div key={i}>{line}</div>
                    ))}
                  </dd>
                </>
              )}
            </dl>
          </div>

          <div className="card">
            <h3 className="card-title">Payments</h3>
            {!row.allocations?.length ? (
              <p className="muted fin-flush">Nothing paid yet.</p>
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

      {editing && (
        <NewBillModal
          from={null}
          existing={row}
          onClose={() => setEditing(false)}
          onCreated={() => {
            setEditing(false);
            load();
          }}
        />
      )}

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
