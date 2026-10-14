import { useCallback, useEffect, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react';
import { Link, Navigate, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api, openPdf, qs } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { DataList, type Column, type FilterDef } from '../../components/DataList';
import { Stat, teamCards, noTeamNote, type TeamShare } from '../../components/charts';
import { Attachments, openAttachment } from '../../components/Attachments';
import { CustomerPicker, type CustomerRef } from '../../components/CustomerPicker';
import { PersonSelect, usePeople } from '../../components/People';
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
  voidedAt: string | null;
  voidReason: string | null;
  /** The day the customer received it; null while awaiting countering. */
  counteredDate: string | null;
  termsDays: number | null;
  termsLabel: string;
  awaitingCounter: boolean;
  /** Files on the invoice — the list's "Invoice copy" column. */
  attachments?: number;
  customer: { id: string; code: string; name: string };
  job: { id: string; number: string; name: string } | null;
  progressBilling: { id: string; number: string; billingNo: number } | null;
  jobOrder: { id: string; number: string } | null;
  salesOrder: { id: string; number: string; poNumber: string | null } | null;
  salesperson: { id: string; name: string } | null;
  team: { id: string; code: string; name: string } | null;
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
export const paymentLink = (id: string) => `/g-fin/payments/${id}`;

interface ReceivablesSummary {
  receivable: number;
  active: number;
  overdue: number;
  overdueCount: number;
  awaiting: number;
  awaitingCount: number;
  collected: number;
  teams: TeamShare[];
}

/** The terms the form offers as chips (`TERMS_CHOICES` on the server); any other is typed. */
export const TERMS_CHOICES = [15, 30, 45, 60];

/** The active teams — the Industry master, KAT, HIT, UIT, GIB, SIT. */
export function useTeams() {
  const [teams, setTeams] = useState<{ id: string; code: string; name: string }[]>([]);
  useEffect(() => {
    api
      .get<{ id: string; code: string; name: string; isActive: boolean }[]>('/reference/industries')
      .then((rows) => setTeams(rows.filter((t) => t.isActive)))
      .catch(() => setTeams([]));
  }, []);
  return teams;
}

/** The first file on an invoice, opened from its row — the sample's PDF column. */
function InvoiceCopy({ row }: { row: Invoice }) {
  const toast = useToast();
  if (!row.attachments) return <span className="faint">—</span>;
  return (
    <button
      type="button"
      className="btn btn-sm"
      aria-label={`Open the invoice copy of ${row.number}`}
      onClick={async (e) => {
        e.stopPropagation();
        try {
          const files = await api.get<{ id: string; fileName: string; mimeType: string }[]>(`/attachments/invoice/${row.id}`);
          if (!files.length || !(await openAttachment(files[0]))) toast('error', 'The file could not be opened');
        } catch {
          toast('error', 'The file could not be opened');
        }
      }}
      onKeyDown={(e) => e.stopPropagation()}
    >
      PDF{row.attachments > 1 ? ` +${row.attachments - 1}` : ''}
    </button>
  );
}

/**
 * Accounts Receivable, laid out on the owner's sample (2026-10-15): SI No.,
 * company, amount, countered date, payment terms, expected collection, sales
 * personnel, team and the invoice copy; cards for the receivable, what is
 * overdue, what is awaiting countering, what was collected and each team's
 * share. Approved billings waiting to be invoiced stay a queue over the list.
 */
export function Receivables() {
  const { can } = useAuth();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const [queue, setQueue] = useState<UninvoicedBilling[] | null>(null);
  const [raising, setRaising] = useState<UninvoicedBilling | null>(null);
  const [creating, setCreating] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const { people } = usePeople('gops.quotations.create');
  const teams = useTeams();

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
      label: 'SI No.',
      sortKey: 'number',
      width: '170px',
      render: (r) => <span className="mono">{r.number}</span>,
    },
    {
      key: 'customer',
      label: 'Company',
      render: (r) => (
        <div>
          <div>{r.customer.name}</div>
          <div className="faint">
            {r.job
              ? `${r.job.number} — ${r.job.name}`
              : r.salesOrder
                ? `Sales order ${r.salesOrder.number}`
                : r.jobOrder
                  ? `Job order ${r.jobOrder.number}`
                  : 'No project'}
          </div>
        </div>
      ),
    },
    {
      key: 'invoiceTotal',
      label: 'Amount',
      align: 'right',
      render: (r) => (
        <div>
          <div className="mono">{formatMoney(r.invoiceTotal)}</div>
          {r.status === 'PAID' ? (
            <div className="faint">paid</div>
          ) : r.outstanding > 0 && r.status !== 'DRAFT' && r.status !== 'CANCELLED' ? (
            <div className={r.daysOverdue > 0 ? 'faint warn' : 'faint'}>{formatMoney(r.outstanding)} to collect</div>
          ) : null}
        </div>
      ),
    },
    {
      key: 'counteredDate',
      label: 'Countered',
      render: (r) =>
        r.counteredDate ? (
          formatDate(r.counteredDate)
        ) : r.awaitingCounter ? (
          <StatusBadge status="AWAITING" extra={{ AWAITING: 'warn' }} label="awaiting" />
        ) : (
          <span className="faint">—</span>
        ),
    },
    {
      key: 'terms',
      label: 'Terms',
      render: (r) => <span className="badge">{r.termsLabel}</span>,
    },
    {
      key: 'dueDate',
      label: 'Expected collection',
      sortKey: 'dueDate',
      render: (r) =>
        r.awaitingCounter || r.status === 'DRAFT' ? (
          <span className="faint">once countered</span>
        ) : (
          <div>
            <div>{formatDate(r.dueDate)}</div>
            {r.daysOverdue > 0 && <div className="faint warn">{r.daysOverdue} days late</div>}
          </div>
        ),
    },
    {
      key: 'salesperson',
      label: 'Sales personnel',
      render: (r) => r.salesperson?.name ?? <span className="faint">—</span>,
    },
    {
      key: 'team',
      label: 'Team',
      render: (r) => (r.team ? <span title={r.team.name}>{r.team.code}</span> : <span className="faint">—</span>),
    },
    {
      key: 'copy',
      label: 'Invoice copy',
      align: 'center',
      render: (r) => <InvoiceCopy row={r} />,
    },
    {
      key: 'status',
      label: 'Status',
      render: (r) => <StatusBadge status={r.status} />,
    },
    { key: 'invoiceDate', label: 'Dated', sortKey: 'invoiceDate', render: (r) => formatDate(r.invoiceDate), optional: true },
    {
      key: 'netCollectible',
      label: 'Collectible',
      align: 'right',
      optional: true,
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
  ];

  const filters: FilterDef[] = [
    { key: 'status', label: 'Status', options: INVOICE_STATUSES },
    { key: 'outstanding', label: 'Balance', options: [{ value: 'true', label: 'Outstanding only' }] },
    { key: 'overdue', label: 'Overdue', options: [{ value: 'true', label: 'Overdue only' }] },
    {
      key: 'countered',
      label: 'Countered',
      options: [
        { value: 'yes', label: 'Countered' },
        { value: 'no', label: 'Awaiting countering' },
      ],
    },
    {
      key: 'salespersonId',
      label: 'Sales personnel',
      options: [{ value: 'none', label: 'Nobody named' }, ...people.map((p) => ({ value: p.id, label: p.name }))],
    },
    {
      key: 'teamId',
      label: 'Team',
      options: [...teams.map((t) => ({ value: t.id, label: `${t.code} — ${t.name}` })), { value: 'none', label: 'No team' }],
    },
    {
      key: 'termsDays',
      label: 'Payment terms',
      options: [0, ...TERMS_CHOICES].map((d) => ({ value: String(d), label: d === 0 ? 'Due on receipt' : `Net ${d}` })),
    },
    {
      key: 'customerId',
      label: 'Customer',
      type: 'lookup',
      placeholder: 'Type a customer name or code…',
      search: async (term: string) =>
        (await api.get<{ id: string; code: string; name: string }[]>(`/customers/lookup${qs({ q: term })}`)).map((c) => ({
          value: c.id,
          label: `${c.name} · ${c.code}`,
        })),
      describe: async (id: string) => {
        const c = await api.get<{ name: string; code: string }>(`/customers/${id}`);
        return `${c.name} · ${c.code}`;
      },
    },
    { key: 'from', toKey: 'to', label: 'Dated', type: 'dateRange' },
    { key: 'dueFrom', toKey: 'dueTo', label: 'Expected collection', type: 'dateRange' },
  ];

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Accounts Receivable</h1>
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
        printPath="/api/invoices/pdf"
        reportPath="/g-fin/reports?kind=receivables"
        columns={columns}
        rowKey={(r) => r.id}
        reloadToken={reload}
        searchPlaceholder="Search SI no., customer, PO, sales order, salesperson…"
        emptyTitle="No invoices yet"
        onRowClick={(r) => navigate(`/g-fin/ar/${r.id}`)}
        selectable
        filters={filters}
        summary={(raw) => {
          const sum = raw as unknown as ReceivablesSummary | undefined;
          if (!sum) return null;
          return (
            <>
              <Stat
                label="Total receivables"
                value={formatMoney(sum.receivable)}
                figure
                sub={[`${sum.active} active invoice${sum.active === 1 ? '' : 's'} pending collection`, noTeamNote(sum.teams)].filter(Boolean).join(' · ')}
                to="/g-fin/ar?outstanding=true"
              />
              <Stat
                label="Overdue"
                value={formatMoney(sum.overdue)}
                figure
                accent={sum.overdue > 0 ? 'warn' : undefined}
                sub={`${sum.overdueCount} invoice${sum.overdueCount === 1 ? '' : 's'}, countered and past due`}
                to="/g-fin/ar?overdue=true"
              />
              <Stat
                label="Awaiting countering"
                value={formatMoney(sum.awaiting)}
                figure
                sub={`${sum.awaitingCount} not yet received by the customer`}
                to="/g-fin/ar?countered=no"
              />
              <Stat label="Collected" value={formatMoney(sum.collected)} figure accent="ok" sub="on the invoices listed" />
              {teamCards(sum.teams, formatMoney, 'invoice')}
            </>
          );
        }}
        actions={
          can('gfin.ar.create') ? (
            <button className="btn btn-primary btn-sm" onClick={() => setCreating(true)}>
              + New invoice
            </button>
          ) : null
        }
      />

      {raising && (
        <InvoiceModal
          billing={raising}
          onClose={() => setRaising(null)}
          onSaved={(id) => {
            setRaising(null);
            setReload((r) => r + 1);
            navigate(`/g-fin/ar/${id}`);
          }}
        />
      )}
      {creating && (
        <InvoiceModal
          onClose={() => setCreating(false)}
          onSaved={(id) => {
            setCreating(false);
            setReload((r) => r + 1);
            navigate(`/g-fin/ar/${id}`);
          }}
        />
      )}
    </div>
  );
}

/** Whole days from one stored date to another — terms, read back off an invoice's dates. */
function daysFrom(from: string, to: string): number {
  const ms = Date.parse(`${to.slice(0, 10)}T00:00:00Z`) - Date.parse(`${from.slice(0, 10)}T00:00:00Z`);
  return Number.isFinite(ms) ? Math.max(0, Math.round(ms / 86_400_000)) : 0;
}

const toCents = (n: number) => Math.round(n * 100) / 100;

/**
 * The payment terms as the owner's sample offers them: Net 15, 30, 45 or 60
 * as chips, or any number of days typed. The terms run from the day the
 * customer counters the invoice.
 */
export function TermsPicker({ value, onChange }: { value: number; onChange: (days: number) => void }) {
  const [custom, setCustom] = useState(!TERMS_CHOICES.includes(value));
  return (
    <div className="ar-terms">
      <div className="scope-switch" role="group" aria-label="Payment terms">
        {TERMS_CHOICES.map((d) => (
          <button
            key={d}
            type="button"
            className={!custom && value === d ? 'active' : ''}
            aria-pressed={!custom && value === d}
            onClick={() => {
              setCustom(false);
              onChange(d);
            }}
          >
            Net {d}
          </button>
        ))}
        <button type="button" className={custom ? 'active' : ''} aria-pressed={custom} onClick={() => setCustom(true)}>
          Other
        </button>
      </div>
      {custom && (
        <NumberInput kind="count" min={0} max={365} aria-label="Payment terms in days" value={value} onChange={(e) => onChange(Number(e.target.value))} />
      )}
    </div>
  );
}

interface OrderOption {
  id: string;
  number: string;
  orderDate: string;
  poNumber: string | null;
  termsDays: number;
  vatRate: number;
  subject: string | null;
  owner: { id: string; name: string };
  net: number;
  invoiced: number;
  left: number;
}

/**
 * The invoice form — the owner's "Add New Sale Invoice": a new invoice
 * (standalone, or billing an issued sales order), one raised from an
 * approved billing, or — with `existing` — a draft modified
 * (`PUT /invoices/:id`). A billing's invoice carries the billing's figures,
 * so only its dates, terms, PO reference and notes are offered. A manual one
 * is entered whole: its lines here, its tax worked out by the server at the
 * company's rates (the sales order's VAT rate when it bills one). The
 * salesperson and team are its source's unless picked; the invoice copy, a
 * PDF, is attached once it is saved.
 */
function InvoiceModal({
  billing,
  existing,
  onClose,
  onSaved,
}: {
  billing?: UninvoicedBilling;
  /** A draft invoice to modify. */
  existing?: Invoice;
  onClose: () => void;
  onSaved: (id: string) => void;
}) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const isNew = !billing && !existing;
  const [terms, setTerms] = useState(existing ? existing.termsDays ?? daysFrom(existing.invoiceDate, existing.dueDate) : 30);
  const today = todayLocal();
  const [form, setForm] = useState({
    invoiceDate: existing?.invoiceDate.slice(0, 10) ?? today,
    poReference: existing?.poReference ?? '',
    notes: existing?.notes ?? '',
  });
  const [customer, setCustomer] = useState<CustomerRef | null>(null);
  const [orders, setOrders] = useState<OrderOption[] | null>(null);
  const [orderId, setOrderId] = useState('');
  // '' = from the document behind it; the server fills those.
  const [salespersonId, setSalespersonId] = useState('');
  const [teamId, setTeamId] = useState('');
  const [copy, setCopy] = useState<File | null>(null);
  const { people } = usePeople('gops.quotations.create');
  const teams = useTeams();
  // A manual invoice's lines are its figures; a billing's are the billing's.
  const manual = isNew || (!!existing && !existing.progressBilling);
  const [lines, setLines] = useState(
    existing
      ? existing.lines.map((l) => ({ description: l.description, detail: l.detail ?? '', amount: l.amount }))
      : isNew
        ? [{ description: '', detail: '', amount: 0 }]
        : [],
  );

  // The customer's issued sales orders, for "Bills".
  useEffect(() => {
    if (!isNew || !customer) {
      setOrders(null);
      return;
    }
    let live = true;
    api
      .get<OrderOption[]>(`/invoices/sales-orders${qs({ customerId: customer.id })}`)
      .then((rows) => live && setOrders(rows))
      .catch(() => live && setOrders([]));
    return () => {
      live = false;
    };
  }, [isNew, customer]);
  const order = orders?.find((o) => o.id === orderId) ?? null;

  function pickOrder(id: string) {
    setOrderId(id);
    const o = orders?.find((x) => x.id === id);
    if (!o) return;
    setTerms(o.termsDays);
    setForm((f) => ({ ...f, poReference: o.poNumber ?? f.poReference }));
    setLines([{ description: `Sales order ${o.number}${o.subject ? ` — ${o.subject}` : ''}`, detail: o.poNumber ? `PO ${o.poNumber}` : '', amount: o.left }]);
  }

  const gross = toCents(lines.reduce((s, l) => s + (l.amount || 0), 0));
  const figures = existing
    ? manual
      ? (() => {
          const vat = toCents(gross * existing.vatRate);
          const ewt = toCents(gross * existing.ewtRate);
          return { invoiceTotal: toCents(gross + vat), netCollectible: toCents(gross + vat - ewt) };
        })()
      : { invoiceTotal: existing.invoiceTotal, netCollectible: existing.netCollectible }
    : billing
      ? { invoiceTotal: billing.invoiceTotal, netCollectible: billing.netCollectible }
      : null;
  const overOrder = !!order && gross > order.left + 0.005;
  const valid =
    (!isNew || !!customer) && !overOrder && (!manual || (gross > 0 && lines.every((l) => !l.amount || l.description.trim())));

  async function save() {
    setBusy(true);
    setError(null);
    const header = {
      invoiceDate: form.invoiceDate,
      termsDays: terms,
      poReference: form.poReference || null,
      notes: form.notes || null,
    };
    const credit = {
      ...(salespersonId ? { salespersonId } : {}),
      ...(teamId ? { teamId } : {}),
    };
    const payloadLines = lines
      .filter((l) => l.description.trim() && l.amount)
      .map((l) => ({ description: l.description, detail: l.detail || null, amount: l.amount }));
    try {
      let id: string;
      if (existing) {
        await api.put(`/invoices/${existing.id}`, manual ? { ...header, lines: payloadLines } : header);
        id = existing.id;
      } else if (billing) {
        id = (await api.post<{ id: string }>(`/invoices/from-billing/${billing.id}`, { ...header, ...credit })).id;
      } else {
        id = (
          await api.post<{ id: string }>('/invoices', {
            ...header,
            ...credit,
            customerId: customer!.id,
            salesOrderId: orderId || null,
            lines: payloadLines,
          })
        ).id;
      }
      if (copy) {
        const form = new FormData();
        form.append('files', copy);
        try {
          await api.post(`/attachments/invoice/${id}`, form);
        } catch {
          toast('error', 'Saved, but the invoice copy could not be attached — add it on the invoice');
        }
      }
      toast('ok', existing ? 'Saved' : 'Invoice raised — issue it when it goes to the customer');
      onSaved(id);
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  }

  const customerName = existing?.customer.name ?? billing?.job.customer.name ?? '';
  const project = existing?.job ?? billing?.job ?? null;

  return (
    <Modal
      title={existing ? `Modify invoice ${existing.number}` : billing ? `New invoice from ${billing.number}` : 'New invoice'}
      onClose={onClose}
      wide={manual}
      footer={
        <ModalFoot onCancel={onClose} busy={busy}>
          <button className="btn btn-primary" onClick={save} disabled={busy || !valid}>
            {existing ? (busy ? 'Saving…' : 'Save') : busy ? 'Raising…' : 'Raise invoice'}
          </button>
        </ModalFoot>
      }
    >
      <ErrorBox error={error} />
      {isNew ? (
        <div className="alert info">
          VAT and EWT are added at the company's rates when it is saved
          {order ? <> — {(order.vatRate * 100).toFixed(0)}% VAT, the sales order's rate</> : null}. It stays a draft until
          you issue it; its terms start when the customer counters it.
        </div>
      ) : manual && existing ? (
        <div className="alert info">
          VAT and EWT are recomputed from the lines at the rates this invoice was raised with —{' '}
          {(existing.vatRate * 100).toFixed(0)}% and {(existing.ewtRate * 100).toFixed(0)}%.
          {existing.jobOrder && <> It bills job order {existing.jobOrder.number}, which does not change.</>}
          {existing.salesOrder && <> It bills sales order {existing.salesOrder.number}, which does not change.</>}
        </div>
      ) : existing ? (
        <div className="alert info">
          The figures are {existing.progressBilling?.number ?? 'the billing'}&rsquo;s and do not change here —
          only the dates, terms, PO reference and notes do.
        </div>
      ) : (
        <div className="alert info">
          Every figure is carried from the billing — the gross, both tax rates and the line
          breakdown. Nothing is recomputed, so an invoice raised months later still prints the tax it
          was billed under.
        </div>
      )}

      {isNew ? (
        <div className="grid grid-2">
          <Field label="Company" required>
            <CustomerPicker
              value={customer}
              allowCreate={false}
              onChange={(c) => {
                setCustomer(c);
                setOrderId('');
              }}
            />
          </Field>
          <Field
            label="Bills"
            hint={
              order
                ? `${formatMoney(order.left)} of ${formatMoney(order.net)} is left to invoice (before VAT)`
                : customer && orders && !orders.length
                  ? 'No issued sales order for this customer — a standalone invoice'
                  : undefined
            }
          >
            <select value={orderId} onChange={(e) => pickOrder(e.target.value)} disabled={!customer}>
              <option value="">Nothing else — a standalone invoice</option>
              {(orders ?? []).map((o) => (
                <option key={o.id} value={o.id} disabled={o.left <= 0}>
                  {o.number} · {formatMoney(o.left)} left{o.subject ? ` · ${o.subject}` : ''}
                </option>
              ))}
            </select>
          </Field>
        </div>
      ) : (
        <dl className="kv">
          <dt>Customer</dt>
          <dd>{customerName}</dd>
          <dt>Project</dt>
          <dd>
            {project ? (
              <>
                <span className="mono">{project.number}</span> — {project.name}
              </>
            ) : (
              <span className="faint">none</span>
            )}
          </dd>
          {figures && (
            <>
              <dt>Invoice total</dt>
              <dd className="mono">{formatMoney(figures.invoiceTotal)}</dd>
              <dt>Collectible</dt>
              <dd className="mono">{formatMoney(figures.netCollectible)}</dd>
            </>
          )}
        </dl>
      )}

      <div className="grid grid-2 fin-gap-top">
        <Field label="Invoice date">
          <input type="date" value={form.invoiceDate} onChange={(e) => setForm({ ...form, invoiceDate: e.target.value })} />
        </Field>
        <Field label="Payment terms" hint={terms === 0 ? 'Due when the customer counters it' : `Due ${terms} days after the customer counters it`}>
          <TermsPicker value={terms} onChange={setTerms} />
        </Field>
      </div>

      <div className="grid grid-2">
        <Field label="Customer PO reference" hint="Optional — what they will match it against">
          <input value={form.poReference} onChange={(e) => setForm({ ...form, poReference: e.target.value })} />
        </Field>
        {!existing && (
          <Field label="Attach invoice copy (PDF)" hint="Optional — the paper the customer receives">
            <input type="file" accept="application/pdf,image/*" onChange={(e) => setCopy(e.target.files?.[0] ?? null)} />
          </Field>
        )}
      </div>

      {!existing && (
        <div className="grid grid-2">
          <Field label="Sales personnel" hint="Blank: whoever sold the order or quotation behind it">
            <PersonSelect value={salespersonId} onChange={setSalespersonId} people={people} placeholder="— from the source —" />
          </Field>
          <Field label="Team" hint="Blank: the quotation's team, else the salesperson's">
            <select value={teamId} onChange={(e) => setTeamId(e.target.value)}>
              <option value="">— from the source —</option>
              {teams.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.code} — {t.name}
                </option>
              ))}
            </select>
          </Field>
        </div>
      )}

      {manual && (
        <>
          <h4 className="fin-section-title">Lines</h4>
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Description</th>
                  <th>Detail</th>
                  <th className="right">Amount (before VAT)</th>
                  <th className="fin-col-tight" />
                </tr>
              </thead>
              <tbody>
                {lines.map((l, i) => {
                  const update = (patch: Partial<typeof l>) => {
                    const next = [...lines];
                    next[i] = { ...l, ...patch };
                    setLines(next);
                  };
                  return (
                    <tr key={i}>
                      <td>
                        <input aria-label={`Line ${i + 1} description`} value={l.description} onChange={(e) => update({ description: e.target.value })} />
                      </td>
                      <td>
                        <input aria-label={`Line ${i + 1} detail`} value={l.detail} onChange={(e) => update({ detail: e.target.value })} />
                      </td>
                      <td>
                        <NumberInput
                          kind="money"
                          step="0.01"
                          aria-label={`Line ${i + 1} amount`}
                          className="fin-amount-input"
                          value={l.amount}
                          onChange={(e) => update({ amount: Number(e.target.value) })}
                        />
                      </td>
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
                  );
                })}
              </tbody>
              <tfoot>
                <tr>
                  <th colSpan={2} className="right">
                    Gross
                  </th>
                  <th className="right mono">{formatMoney(gross)}</th>
                  <th />
                </tr>
              </tfoot>
            </table>
          </div>
          {overOrder && order && (
            <div className="alert error fin-gap-top fin-flush">
              Only {formatMoney(order.left)} of {order.number} is left to invoice — {formatMoney(gross)} is more than that.
            </div>
          )}
          <button className="btn btn-sm fin-gap-top-sm" onClick={() => setLines([...lines, { description: '', detail: '', amount: 0 }])}>
            + Add line
          </button>
        </>
      )}

      <Field label="Notes">
        <textarea rows={2} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
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
  const [editing, setEditing] = useState(false);
  const [panel, setPanel] = useState<'counter' | 'credit' | null>(null);
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

  async function cancel(reason: string) {
    await api.post(`/invoices/${id}/cancel`, { reason });
    toast('ok', 'Cancelled');
    await load();
  }

  // Mirror the routes: Modify a draft; cancel anything not cancelled with no
  // money applied to it — both for whoever may edit every invoice.
  const canModify = row.status === 'DRAFT' && can('gfin.ar.edit_all');
  const owed = row.status === 'ISSUED' || row.status === 'PARTIALLY_PAID';
  const canCounter = (owed || row.status === 'PAID') && can('gfin.ar.edit_all');
  const canCollect = owed && can('gfin.ar.create');
  const canCancel = row.status !== 'CANCELLED' && !row.allocations?.length && can('gfin.ar.edit_all');
  const releases = row.progressBilling
    ? ` ${row.progressBilling.number} goes back to be invoiced again.`
    : row.jobOrder
      ? ` Job order ${row.jobOrder.number} can be invoiced again.`
      : '';

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
            {row.salesOrder && (
              <>
                {' · bills sales order '}
                <Link to={`/g-ops/sales-orders/${row.salesOrder.id}`} className="mono">
                  {row.salesOrder.number}
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
            {/* One primary: until the customer has it, countering is the
                next step; after that, collecting is. */}
            {row.awaitingCounter && canCounter && (
              <button className="btn btn-primary" onClick={() => setPanel('counter')}>
                Mark countered
              </button>
            )}
            {canCollect && (
              <button className={`btn ${row.awaitingCounter && canCounter ? '' : 'btn-primary'}`} onClick={() => setPaying(true)}>
                Record collection
              </button>
            )}
          </>
        }
        print={`/api/invoices/${row.id}/pdf`}
        more={[
          !row.awaitingCounter &&
            !!row.counteredDate &&
            canCounter && {
              label: 'Change countered date',
              hint: 'The expected collection moves with it',
              onSelect: () => setPanel('counter'),
            },
          row.status !== 'CANCELLED' &&
            can('gfin.ar.edit_all') && {
              label: 'Change salesperson or team',
              onSelect: () => setPanel('credit'),
            },
          {
            label: 'Print without attachments',
            onSelect: () => openPdf(`/api/invoices/${row.id}/pdf?attachments=0`, () => toast('error', 'The invoice could not be printed')),
          },
          row.ewtAmount > 0 &&
            can('gfin.ar.edit_all') && {
              label: row.ewtCertificateNo ? 'Modify BIR 2307' : 'Record BIR 2307',
              hint: 'The certificate for the EWT withheld at source',
              onSelect: () => setCertificate(true),
            },
          canCancel && {
            label: 'Cancel invoice',
            danger: true,
            confirm: {
              title: `Cancel ${row.number}?`,
              body: `${row.status === 'DRAFT' ? 'It was never issued.' : 'It stops being a receivable.'}${releases}`,
              confirmLabel: 'Cancel invoice',
              reason: 'required',
              reasonLabel: 'Why? (kept on the invoice)',
              minReason: 3,
              onConfirm: cancel,
            },
          },
        ]}
        modify={canModify ? () => setEditing(true) : undefined}
        confirm={confirm}
      />

      <ErrorBox error={error} />

      {panel === 'counter' && (
        <CounterPanel
          invoice={row}
          onClose={() => setPanel(null)}
          onSaved={() => {
            setPanel(null);
            load();
          }}
        />
      )}
      {panel === 'credit' && (
        <CreditPanel
          invoice={row}
          onClose={() => setPanel(null)}
          onSaved={() => {
            setPanel(null);
            load();
          }}
        />
      )}
      {row.awaitingCounter && panel !== 'counter' && (
        <div className="alert info">
          Issued and awaiting countering — its {row.termsLabel.toLowerCase()} terms start when the customer receives it, so it
          is not overdue whatever its date.
        </div>
      )}

      {row.status === 'CANCELLED' && (
        <div className="alert warn">
          Cancelled{row.voidedAt && <> on {formatDate(row.voidedAt)}</>}
          {row.voidReason && <> — {row.voidReason}</>}.
        </div>
      )}
      {row.status !== 'CANCELLED' && row.outstanding > 0 && row.daysOverdue > 0 && (
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
              <dt>Countered</dt>
              <dd>{row.counteredDate ? formatDate(row.counteredDate) : row.awaitingCounter ? <span className="warn">Awaiting countering</span> : '—'}</dd>
              <dt>Payment terms</dt>
              <dd>
                <span className="badge">{row.termsLabel}</span>
              </dd>
              <dt>Expected collection</dt>
              <dd>
                {row.awaitingCounter ? (
                  <span className="faint">{row.termsDays ?? 0} days after it is countered</span>
                ) : (
                  <>
                    {formatDate(row.dueDate)}
                    {row.daysOverdue > 0 && <span className="warn"> · {row.daysOverdue} days late</span>}
                  </>
                )}
              </dd>
              <dt>Sales personnel</dt>
              <dd>{row.salesperson?.name ?? <span className="faint">—</span>}</dd>
              <dt>Team</dt>
              <dd>{row.team ? `${row.team.code} — ${row.team.name}` : <span className="faint">—</span>}</dd>
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

      <Attachments
        entityType="invoice"
        entityId={row.id}
        title="Invoice copy and files"
        hint="The customer's countered copy, the signed delivery — printed behind the invoice"
        canEdit={can('gfin.ar.create') || can('gfin.ar.edit_all')}
      />

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

      {editing && (
        <InvoiceModal
          existing={row}
          onClose={() => setEditing(false)}
          onSaved={() => {
            setEditing(false);
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

/**
 * "Mark countered" — the day the customer received the invoice, in the page
 * (never a dialog). The expected collection is that day plus the terms,
 * which may be changed here too.
 */
function CounterPanel({ invoice, onClose, onSaved }: { invoice: Invoice; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const [day, setDay] = useState(invoice.counteredDate?.slice(0, 10) ?? todayLocal());
  const [terms, setTerms] = useState(invoice.termsDays ?? daysFrom(invoice.invoiceDate, invoice.dueDate));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const expected = (() => {
    const d = new Date(`${day}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + terms);
    return d.toISOString().slice(0, 10);
  })();
  async function save() {
    setBusy(true);
    setError(null);
    try {
      await api.post(`/invoices/${invoice.id}/counter`, { counteredDate: day, termsDays: terms });
      toast('ok', `Countered — expected ${formatDate(expected)}`);
      onSaved();
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  }
  return (
    <section className="card" aria-labelledby="ar-counter">
      <h3 id="ar-counter" className="card-title">
        {invoice.counteredDate ? 'Change the countered date' : 'Mark countered'}
      </h3>
      <ErrorBox error={error} />
      <div className="grid grid-2">
        <Field label="Received by the customer on">
          <input type="date" value={day} min={invoice.invoiceDate.slice(0, 10)} max={todayLocal()} onChange={(e) => setDay(e.target.value)} />
        </Field>
        <Field label="Payment terms" hint={`Expected collection: ${formatDate(expected)}`}>
          <TermsPicker value={terms} onChange={setTerms} />
        </Field>
      </div>
      <div className="card-foot">
        <button className="btn btn-sm" onClick={onClose} disabled={busy}>
          Cancel
        </button>
        <button className="btn btn-sm btn-primary" onClick={save} disabled={busy || !day}>
          {busy ? 'Saving…' : 'Save'}
        </button>
      </div>
    </section>
  );
}

/** Who is credited with the invoice — in the page, like countering. */
function CreditPanel({ invoice, onClose, onSaved }: { invoice: Invoice; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const { people } = usePeople('gops.quotations.create');
  const teams = useTeams();
  const [salespersonId, setSalespersonId] = useState(invoice.salesperson?.id ?? '');
  const [teamId, setTeamId] = useState(invoice.team?.id ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  async function save() {
    setBusy(true);
    setError(null);
    try {
      await api.patch(`/invoices/${invoice.id}/credit`, { salespersonId: salespersonId || null, teamId: teamId || null });
      toast('ok', 'Saved');
      onSaved();
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  }
  return (
    <section className="card" aria-labelledby="ar-credit">
      <h3 id="ar-credit" className="card-title">
        Salesperson and team
      </h3>
      <ErrorBox error={error} />
      <div className="grid grid-2">
        <Field label="Sales personnel">
          <PersonSelect value={salespersonId} onChange={setSalespersonId} people={people} current={invoice.salesperson} />
        </Field>
        <Field label="Team">
          <select value={teamId} onChange={(e) => setTeamId(e.target.value)}>
            <option value="">— none —</option>
            {teams.map((t) => (
              <option key={t.id} value={t.id}>
                {t.code} — {t.name}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <div className="card-foot">
        <button className="btn btn-sm" onClick={onClose} disabled={busy}>
          Cancel
        </button>
        <button className="btn btn-sm btn-primary" onClick={save} disabled={busy}>
          {busy ? 'Saving…' : 'Save'}
        </button>
      </div>
    </section>
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
  const navigate = useNavigate();
  const [params] = useSearchParams();

  // A payment has a page of its own; links written before it (a notification,
  // a bookmark) said `?payment=<id>` and still land there.
  const legacyId = params.get('payment');
  if (legacyId) return <Navigate to={paymentLink(legacyId)} replace />;

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
      // Marking a payment cleared is done on its page (the row opens it),
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
        </div>
      </div>

      <DataList<PaymentRow>
        listKey="payments"
        endpoint="/payments"
        printPath="/api/payments/pdf"
        columns={columns}
        rowKey={(r) => r.id}
        searchPlaceholder="Search number, reference, customer, supplier, person…"
        emptyTitle="No payments recorded yet"
        emptyHint="An uncleared cheque is recorded but counts as cash only once it clears."
        onRowClick={(r) => navigate(paymentLink(r.id))}
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

/**
 * One payment: `/g-fin/payments/:id` — where a notification, a report row or
 * an invoice's collection list points. Every record has a page (rule 19); this
 * one used to open as a modal over the list.
 *
 * A payment is not modified: what it settled is the record. It is cleared once
 * the bank says so, or — by whoever may delete receivables or payables —
 * deleted, which the API answers by re-deriving every document it settled.
 */
export function PaymentDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const toast = useToast();
  const { can } = useAuth();
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

  if (error && !row) return <ErrorBox error={error} />;
  if (!row) return <Loading />;

  // The API clears on either edit right and deletes on either delete right;
  // the buttons follow the same rules.
  const canClear = !row.clearedAt && (can('gfin.ar.edit_all') || can('gfin.ap.edit_all'));
  const canDelete = can('gfin.ar.delete') || can('gfin.ap.delete');
  const direction = row.kind === 'RECEIPT' ? 'money in' : 'money out';

  // Thrown, not caught: the confirm bar shows the refusal and stays open.
  async function clear() {
    await api.post(`/payments/${id}/clear`);
    toast('ok', 'Marked cleared');
    await load();
  }

  async function remove() {
    await api.del(`/payments/${id}`);
    toast('ok', `${row!.number} deleted — what it settled is owed again`);
    navigate('/g-fin/payments', { replace: true });
  }

  const party = row.customer ? (
    <Link to={`/g-ops/customers/${row.customer.id}`}>{row.customer.name}</Link>
  ) : row.supplier ? (
    <Link to={`/g-chain/suppliers/${row.supplier.id}`}>{row.supplier.name}</Link>
  ) : (
    partyName(row)
  );

  return (
    <div>
      <RecordHeader
        type="Payment"
        code={row.number}
        title={`${row.kind === 'RECEIPT' ? 'From' : 'To'} ${partyName(row)}`}
        status={row.clearedAt ? 'CLEARED' : 'UNCLEARED'}
        statusLabel={row.clearedAt ? 'cleared' : 'uncleared'}
        statusExtra={{ CLEARED: 'ok', UNCLEARED: 'warn' }}
        amount={formatMoney(row.amount)}
        amountLabel={row.kind === 'RECEIPT' ? 'Received' : 'Paid out'}
        meta={
          <>
            {direction} · {formatDate(row.paymentDate)} · {humanise(row.method)}
            {row.reference && (
              <>
                {' · '}
                <span className="mono">{row.reference}</span>
              </>
            )}
          </>
        }
        actions={
          canClear && (
            <button
              className="btn btn-primary"
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
          )
        }
        more={[
          canDelete && {
            label: 'Delete',
            danger: true,
            confirm: {
              title: `Delete ${row.number}?`,
              body: `${formatMoney(row.amount)} comes off ${
                row.allocations.length === 1 ? 'the document it settled' : `the ${row.allocations.length} documents it settled`
              }, and each goes back to owing what it owed before. Kept in the audit trail.`,
              confirmLabel: 'Delete payment',
              onConfirm: remove,
            },
          },
        ]}
        confirm={confirm}
      />

      <ErrorBox error={error} />

      {!row.clearedAt && (
        <div className="alert warn">Not cleared yet — it does not count as cash until the bank says it has.</div>
      )}

      <div className="grid grid-2">
        <div className="card">
          <h3 className="card-title">Payment</h3>
          <dl className="kv">
            <dt>Direction</dt>
            <dd>
              <StatusBadge status={row.kind} extra={{ RECEIPT: 'ok', DISBURSEMENT: '' }} label={direction} />
            </dd>
            <dt>{row.kind === 'RECEIPT' ? 'From' : 'To'}</dt>
            <dd>{party}</dd>
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
            <dd>{row.clearedAt ? formatDate(row.clearedAt) : '—'}</dd>
            <dt>Recorded by</dt>
            <dd>{row.recordedBy.name}</dd>
            {row.notes && (
              <>
                <dt>Notes</dt>
                <dd>{row.notes}</dd>
              </>
            )}
          </dl>
        </div>

        <div className="card">
          <h3 className="card-title">What it settled</h3>
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
        </div>
      </div>
    </div>
  );
}
