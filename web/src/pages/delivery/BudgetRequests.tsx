import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api, type ListResult } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { DataList, type Column, type FilterDef } from '../../components/DataList';
import { Stat } from '../../components/charts';
import { usePeople } from '../../components/People';
import { useTeams } from '../finance/Receivables';
import { RecordHeader } from '../../components/RecordHeader';
import { useConfirm } from '../../components/Confirm';
import { NumberInput } from '../../components/NumberInput';
import { useBackLink } from '../../components/Navigation';
import { ApprovalStepper, DocumentApproval, DecisionNote } from '../../components/ApprovalStepper';
import { ErrorBox, Loading, StatusBadge, formatDate, formatMoney, humanise, useToast, type Tone } from '../../components/ui';
import { RecordPaymentModal, paymentLink } from '../finance/Receivables';
import { CLAIM_TONES } from '../finance/Expenses';
import { RequestItemsCard, type RequestItem } from '../../components/RequestLines';
import { Attachments } from '../../components/Attachments';
import type { CurrentOfficeLine } from '../../components/OfficeLine';
import { BudgetCard, SOURCE_WORDS, type RequestBudget, type RequestSource } from '../../components/BudgetCard';
export { SOURCE_WORDS, type RequestSource };

/**
 * Budget requests — PROJECT CASH (2026-10-07, the owner's call).
 *
 * "It is not about changing the total budget allocated for the project; it
 * is about requesting cash so that the project team can purchase something
 * without the need for a purchase requisition." The project's manager allows
 * it, finance approves and releases it in one voucher, the team spends it,
 * and whoever asked accounts for it with receipts — a liquidation filed in
 * Expenses that names the request. Nothing reaches the project's budget until
 * that liquidation is approved, and then only what was actually spent.
 *
 * Not a cash advance: that is the company's term for a personal loan to a
 * person. Same arithmetic, different document, its own liquidation days.
 */

/** APPROVED means finance owes a release — information, not a finished thing. */
export const BUDGET_REQUEST_TONES: Record<string, Tone> = {
  APPROVED: 'info',
  RELEASED: 'warn',
  REFUND_DUE: 'warn',
  LIQUIDATED: 'ok',
};

const STATUSES = [
  { value: 'DRAFT', label: 'Draft' },
  { value: 'PENDING_APPROVAL', label: 'Pending approval' },
  { value: 'APPROVED', label: 'Approved — awaiting release' },
  { value: 'RELEASED', label: 'Released — awaiting liquidation' },
  { value: 'REFUND_DUE', label: 'Unspent cash owed back' },
  { value: 'LIQUIDATED', label: 'Liquidated' },
  { value: 'REJECTED', label: 'Rejected' },
  { value: 'CANCELLED', label: 'Cancelled' },
];

interface Liquidation {
  id: string;
  number: string;
  status: string;
  total: number;
  claimDate: string;
  approvedAt: string | null;
}

export interface BudgetRequest {
  id: string;
  number: string;
  status: string;
  reason: string;
  notes: string | null;
  cancelReason: string | null;
  amount: number;
  amountReleased: number;
  amountSpent: number;
  amountRefunded: number;
  neededBy: string | null;
  releasedAt: string | null;
  liquidationDueDate: string | null;
  approvedAt: string | null;
  liquidatedAt: string | null;
  createdAt: string;
  requestedBy: { id: string; name: string; email: string; position: string | null };
  /** The requester's team. */
  team: { label: string; title: string; teamId: string | null } | null;
  /** The project, once it has one — raised on it, or handed to it by a project built from its record. */
  job: { id: string; number: string; name: string; projectManager: { id: string; name: string } | null } | null;
  /** What the cash is for (2026-10-26): the project, else the sales order, quotation or costing. */
  for: RequestSource | null;
  /** The record it was raised on, kept once a project took it over. */
  raisedOn: RequestSource | null;
  costCategory: { id: string; name: string };
  /** An office budget line instead of a record (2026-11-10); the cost category then means nothing. */
  officeBudgetLine?: CurrentOfficeLine | null;
  toRelease: number;
  spent: number;
  excessDue: number;
  refundDue: number;
  refundOutstanding: number;
  liquidationOverdue: boolean;
  daysToLiquidate: number | null;
  liquidation: Liquidation | null;
  liquidations: Liquidation[];
  /** The breakdown of what the cash buys; the amount is their sum. */
  items?: RequestItem[];
  canEdit?: boolean;
  approvalRoute?: { name: string; steps: { name: string; approvers: { id: string; name: string }[] }[] } | null;
  /** The register's "Available after" on the request's budget line; null once it takes nothing more. */
  availableAfter?: number | null;
  /** A TRAVEL request (2026-11-10): the journey, and whether finance booked and paid it itself. */
  isTravel?: boolean;
  travelMode?: 'SHIPPING' | 'LAND' | 'AIR' | null;
  travelFrom?: string | null;
  travelTo?: string | null;
  departOn?: string | null;
  returnOn?: string | null;
  travellers?: string | null;
  carrier?: string | null;
  paidDirect?: boolean;
  canBook?: boolean;
  approvalType?: 'budget_request' | 'travel_request';
  /** "Against the project budget" (GET /:id) — Budget Monitoring's figures, this request's own commitment left out. */
  budget?: RequestBudget;
  allocations?: {
    id: string;
    amount: number;
    payment: { id: string; number: string; kind: string; paymentDate: string; method: string; reference: string | null; clearedAt: string | null };
  }[];
}

// The budget types and the "Against the project budget" card are
// `components/BudgetCard.tsx` since 2026-11-09 — shared with the expense claim
// and the cash advance.
const RequestBudgetCard = BudgetCard;

/** When the receipts are due, and whether that has passed. */
function Deadline({ row }: { row: BudgetRequest }) {
  if (row.status !== 'RELEASED' || !row.liquidationDueDate) {
    return <span className="faint">{row.liquidationDueDate ? formatDate(row.liquidationDueDate) : '—'}</span>;
  }
  return (
    <div>
      <div>{formatDate(row.liquidationDueDate)}</div>
      {row.liquidationOverdue ? (
        <div className="faint warn">{Math.abs(row.daysToLiquidate ?? 0)} days overdue</div>
      ) : (
        <div className="faint">{row.daysToLiquidate} days left</div>
      )}
    </div>
  );
}

function StatusCell({ row }: { row: BudgetRequest }) {
  return (
    <StatusBadge
      status={row.liquidationOverdue ? 'OVERDUE' : row.status}
      extra={BUDGET_REQUEST_TONES}
      label={row.liquidationOverdue ? 'Liquidation overdue' : undefined}
    />
  );
}

interface RequestsSummary {
  total: number;
  count: number;
  approved: number;
  approvedCount: number;
  pending: number;
  pendingCount: number;
  toRelease: number;
  toReleaseCount: number;
  released: number;
  releasedCount: number;
  spent: number;
  returned: number;
  owedBack: number;
  refundDueCount: number;
}

/**
 * The register, in two dresses: G-OPS's (every project's requests, as the
 * project side raises them) and G-FIN's — the owner's module 4: BR No.,
 * Requester, Team, Project / Purpose, Amount, Date needed,
 * Status, under the cards Sum of all budget requests, Approved funds, Pending
 * approval and To release. One query, one component, so the two can never
 * list different sets.
 */
export const TRAVEL_MODE_WORDS: Record<string, string> = { SHIPPING: 'Shipping line', LAND: 'Land transportation', AIR: 'Air flight' };

export function BudgetRequestsList({ finance = false, travel = false }: { finance?: boolean; travel?: boolean }) {
  const navigate = useNavigate();
  const base = `${finance ? '/g-fin' : '/g-ops'}/${travel ? 'travel-requests' : 'budget-requests'}`;
  const word = travel ? 'travel request' : 'budget request';
  const { can } = useAuth();
  const { people } = usePeople('gops.budget_requests.create');
  const teams = useTeams();

  const columns: Column<BudgetRequest>[] = [
    { key: 'number', label: travel ? 'TR No.' : 'BR No.', sortKey: 'number', width: '150px', render: (r) => <span className="mono">{r.number}</span> },
    { key: 'requestedBy', label: 'Requester', render: (r) => r.requestedBy.name },
    {
      key: 'team',
      label: 'Team',
      render: (r) => (r.team ? <span title={r.team.title}>{r.team.label}</span> : <span className="faint">—</span>),
    },
    ...(travel
      ? ([
          {
            key: 'journey',
            label: 'Journey',
            render: (r) => (
              <div>
                <div>
                  {r.travelFrom} → {r.travelTo}
                </div>
                <div className="faint">
                  {TRAVEL_MODE_WORDS[r.travelMode ?? ''] ?? 'Travel'}
                  {r.departOn ? ` · ${formatDate(r.departOn)}` : ''}
                  {r.returnOn ? ` – ${formatDate(r.returnOn)}` : ''}
                </div>
              </div>
            ),
          },
        ] as Column<BudgetRequest>[])
      : []),
    {
      key: 'job',
      label: 'For / Purpose',
      render: (r) => (
        <div>
          <div>{r.reason}</div>
          <div className="faint">{r.for ? <ForLabel source={r.for} /> : '—'}</div>
        </div>
      ),
    },
    { key: 'amount', label: 'Amount', sortKey: 'amount', align: 'right', render: (r) => <span className="mono">{formatMoney(r.amount)}</span> },
    {
      key: 'neededBy',
      label: 'Date needed',
      sortKey: 'neededBy',
      render: (r) => (r.neededBy ? formatDate(r.neededBy) : <span className="faint">—</span>),
    },
    { key: 'status', label: 'Status', render: (r) => <StatusCell row={r} /> },
    {
      key: 'availableAfter',
      label: 'Available after',
      align: 'right',
      render: (r) =>
        r.availableAfter == null ? (
          <span className="faint">—</span>
        ) : (
          <span className={`mono${r.availableAfter < 0 ? ' del-danger' : ''}`} title={`${r.officeBudgetLine ? `${r.officeBudgetLine.code} ${r.officeBudgetLine.name}` : r.costCategory.name} after this request`}>
            {formatMoney(r.availableAfter)}
          </span>
        ),
    },
    { key: 'category', label: 'Budget line', render: (r) => (r.officeBudgetLine ? `${r.officeBudgetLine.code} ${r.officeBudgetLine.name}` : r.costCategory.name), optional: true },
    { key: 'createdAt', label: 'Raised', sortKey: 'createdAt', render: (r) => formatDate(r.createdAt), optional: true },
    {
      key: 'amountReleased',
      label: 'Released',
      align: 'right',
      optional: true,
      render: (r) => (r.amountReleased > 0 ? <span className="mono">{formatMoney(r.amountReleased)}</span> : <span className="faint">—</span>),
    },
    { key: 'liquidationDueDate', label: 'Liquidate by', sortKey: 'liquidationDueDate', optional: true, render: (r) => <Deadline row={r} /> },
  ];

  const filters: FilterDef[] = [
    { key: 'status', label: 'Status', options: STATUSES },
    { key: 'pending', label: 'Pending', options: [{ value: 'true', label: 'Pending approval' }] },
    { key: 'approved', label: 'Approved funds', options: [{ value: 'true', label: 'Approved and after' }] },
    { key: 'overdue', label: 'Liquidation', options: [{ value: 'true', label: 'Overdue only' }] },
    { key: 'requestedById', label: 'Requester', options: people.map((p) => ({ value: p.id, label: p.name })) },
    {
      key: 'teamId',
      label: 'Team',
      options: [...teams.map((t) => ({ value: t.id, label: `${t.code} — ${t.name}` })), { value: 'none', label: 'No team' }],
    },
    { key: 'neededFrom', toKey: 'neededTo', label: 'Date needed', type: 'dateRange' },
    // What the cash is for (2026-10-26).
    { key: 'for', label: 'For', options: (Object.keys(SOURCE_WORDS) as RequestSource['kind'][]).map((k) => ({ value: k, label: SOURCE_WORDS[k] })) },
    ...(travel
      ? [{ key: 'travelMode', label: 'Travel by', options: Object.entries(TRAVEL_MODE_WORDS).map(([value, label]) => ({ value, label })) } as FilterDef]
      : []),
  ];

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>{travel ? 'Travel Requests' : 'Budget Requests'}</h1>
        </div>
      </div>

      <DataList<BudgetRequest>
        listKey={`${finance ? 'fin-' : ''}${travel ? 'travel-requests' : 'budget-requests'}`}
        endpoint="/budget-requests"
        // The two registers are one list (rule 15): a travel request has its own menu entry.
        initialFilters={{ travel: travel ? 'yes' : 'no' }}
        printPath="/api/budget-requests/pdf"
        reportPath={finance && !travel ? '/g-fin/reports?kind=budget-requests' : undefined}
        columns={columns}
        rowKey={(r) => r.id}
        scoped={!finance}
        selectable
        searchPlaceholder={travel ? 'Search TR no., purpose, route, carrier, requester…' : 'Search BR no., purpose, project, requester…'}
        onRowClick={(r) => navigate(`/g-ops/budget-requests/${r.id}`)}
        emptyTitle={`No ${word}s`}
        emptyHint={
          travel
            ? 'A ticket, a fare or a shipping-line booking — charged to a project, a sales order, a quotation, a costing or an office budget line.'
            : 'A request is charged to a project, a sales order, a quotation, a costing or an office budget line.'
        }
        filters={filters}
        summary={(raw) => {
          const sum = raw as unknown as RequestsSummary | undefined;
          if (!sum) return null;
          return (
            <>
              <Stat label={`Sum of all ${word}s`} value={formatMoney(sum.total)} figure sub={`${sum.count} request${sum.count === 1 ? '' : 's'}, rejected and cancelled left out`} />
              <Stat label="Approved funds" value={formatMoney(sum.approved)} figure accent="ok" sub={`${sum.approvedCount} approved`} to={`${base}?approved=true`} />
              <Stat
                label="Pending approval"
                value={formatMoney(sum.pending)}
                figure
                accent={sum.pending > 0 ? 'warn' : undefined}
                sub={`${sum.pendingCount} waiting`}
                to={`${base}?pending=true`}
              />
              <Stat
                label="To release"
                value={formatMoney(sum.toRelease)}
                figure
                sub={`${sum.toReleaseCount} approved, not yet ${travel ? 'released or booked' : 'released'}`}
                to={`${base}?status=APPROVED`}
              />
            </>
          );
        }}
        actions={
          can('gops.budget_requests.create') ? (
            <button className="btn btn-primary btn-sm" onClick={() => navigate(`/g-ops/budget-requests/new${travel ? '?kind=travel' : ''}`)}>
              + New {word}
            </button>
          ) : null
        }
      />

    </div>
  );
}

export function BudgetRequests() {
  return <BudgetRequestsList />;
}

export function FinanceBudgetRequests() {
  return <BudgetRequestsList finance />;
}

/**
 * Finance books and pays an approved travel request itself (2026-11-10, the
 * owner's call: "finance can also pay, particularly the booking of an airline
 * using a credit card"): what the booking cost — never more than approved —
 * the method, the reference. One voucher; nothing to liquidate.
 */
function BookTravelPanel({ row, onDone, onCancel }: { row: BudgetRequest; onDone: () => void; onCancel: () => void }) {
  const toast = useToast();
  const [amount, setAmount] = useState(String(row.amount));
  const [method, setMethod] = useState('CREDIT_CARD');
  const [paymentDate, setPaymentDate] = useState('');
  const [reference, setReference] = useState('');
  const [carrier, setCarrier] = useState(row.carrier ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const over = Number(amount) > row.amount + 0.005;

  async function book() {
    setBusy(true);
    setError(null);
    try {
      const res = await api.post<{ paymentNumber: string }>(`/budget-requests/${row.id}/book`, {
        amount: Number(amount),
        method,
        paymentDate: paymentDate || null,
        reference: reference.trim() || null,
        carrier: carrier.trim() || null,
      });
      toast('ok', `Booked — ${res.paymentNumber}`);
      onDone();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card" aria-labelledby="br-book">
      <h3 id="br-book" className="card-title">Book and pay directly</h3>
      <p className="muted">
        Finance pays the carrier itself — nobody holds cash, so there is nothing to liquidate. What is paid is charged at once to what
        the request is for.
      </p>
      <div className="grid grid-2">
        <label className="field">
          <span>What the booking cost</span>
          <NumberInput kind="money" value={amount} min={0.01} onChange={(e) => setAmount(e.target.value)} />
          {over && <span className="field-error">More than the {formatMoney(row.amount)} approved</span>}
        </label>
        <label className="field">
          <span>Paid by</span>
          <select value={method} onChange={(e) => setMethod(e.target.value)}>
            <option value="CREDIT_CARD">Company credit card</option>
            <option value="BANK_TRANSFER">Bank transfer</option>
            <option value="ONLINE">Online</option>
            <option value="CHECK">Cheque</option>
            <option value="CASH">Cash</option>
          </select>
        </label>
        <label className="field">
          <span>Paid on</span>
          <input type="date" value={paymentDate} onChange={(e) => setPaymentDate(e.target.value)} />
        </label>
        <label className="field">
          <span>Booking reference</span>
          <input value={reference} maxLength={200} placeholder="e.g. the ticket or booking number" onChange={(e) => setReference(e.target.value)} />
        </label>
        <label className="field">
          <span>Carrier</span>
          <input value={carrier} maxLength={200} onChange={(e) => setCarrier(e.target.value)} />
        </label>
      </div>
      <ErrorBox error={error} />
      <div className="row card-foot">
        <button type="button" className="btn btn-sm" disabled={busy} onClick={onCancel}>
          Cancel
        </button>
        <button type="button" className="btn btn-primary btn-sm" disabled={busy || over || !(Number(amount) > 0)} onClick={() => void book()}>
          Book and pay
        </button>
      </div>
    </section>
  );
}

/** Travel Requests (2026-11-10): the same register, travel requests alone — G-OPS's and G-FIN's entries. */
export function TravelRequests() {
  return <BudgetRequestsList travel />;
}

export function FinanceTravelRequests() {
  return <BudgetRequestsList finance travel />;
}

/**
 * Budget Liquidations — the owner's module 5 (2026-10-15): the requests
 * whose cash went out, as the liquidation account reads them — released,
 * spent, the return — with the next step on each row: the requester's
 * "Actual entry" (the itemised liquidation, its receipts attached) while it
 * is out, finance's "Process" (the refund) while unspent cash is owed back.
 * The same rows as the register, narrowed to `released=true`.
 */
export function FinanceLiquidations() {
  const navigate = useNavigate();
  const { me } = useAuth();
  const teams = useTeams();
  const { people } = usePeople('gops.budget_requests.create');
  const ret = (r: BudgetRequest) => (r.liquidatedAt ? Math.max(0, Math.round((r.amountReleased - r.spent) * 100) / 100) : null);

  const columns: Column<BudgetRequest>[] = [
    { key: 'number', label: 'BR No.', sortKey: 'number', width: '150px', render: (r) => <span className="mono">{r.number}</span> },
    {
      key: 'requestedBy',
      label: 'Requester / Team',
      render: (r) => (
        <div>
          <div>{r.requestedBy.name}</div>
          <div className="faint">{r.team?.label ?? '—'}</div>
        </div>
      ),
    },
    {
      key: 'job',
      label: 'For / Purpose',
      render: (r) => (
        <div>
          <div>{r.reason}</div>
          <div className="faint">{r.for ? <ForLabel source={r.for} /> : '—'}</div>
        </div>
      ),
    },
    { key: 'amountReleased', label: 'Released', align: 'right', render: (r) => <span className="mono">{formatMoney(r.amountReleased)}</span> },
    {
      key: 'spent',
      label: 'Spent',
      align: 'right',
      render: (r) =>
        r.liquidatedAt ? (
          <span className="mono">{formatMoney(r.spent)}</span>
        ) : r.liquidation ? (
          <span className="faint">{formatMoney(r.liquidation.total)} filed</span>
        ) : (
          <span className="faint">—</span>
        ),
    },
    {
      key: 'return',
      label: 'Return',
      align: 'right',
      render: (r) => {
        const back = ret(r);
        return back === null ? <span className="faint">—</span> : <span className="mono">{formatMoney(back)}</span>;
      },
    },
    { key: 'status', label: 'Status', render: (r) => <StatusCell row={r} /> },
    {
      key: 'actions',
      label: 'Actions',
      render: (r) => {
        const go = (act: string) => (e: React.MouseEvent) => {
          e.stopPropagation();
          navigate(`/g-ops/budget-requests/${r.id}?act=${act}`);
        };
        if (r.status === 'RELEASED' && !r.liquidation && r.requestedBy.id === me?.user.id) {
          return (
            <button type="button" className="btn btn-sm" onClick={go('liquidate')}>
              Actual entry
            </button>
          );
        }
        if (r.status === 'REFUND_DUE' && r.refundOutstanding > 0) {
          return (
            <button type="button" className="btn btn-sm" onClick={go('refund')}>
              Process
            </button>
          );
        }
        if (r.status === 'RELEASED' && r.liquidation) return <span className="faint">Liquidation {humanise(r.liquidation.status).toLowerCase()}</span>;
        if (r.status === 'RELEASED') return <Deadline row={r} />;
        return <span className="faint">—</span>;
      },
    },
  ];

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Budget Liquidations</h1>
        </div>
      </div>
      <DataList<BudgetRequest>
        listKey="fin-budget-liquidations"
        endpoint="/budget-requests"
        printPath="/api/budget-requests/pdf"
        reportPath="/g-fin/reports?kind=liquidations"
        initialFilters={{ released: 'true' }}
        columns={columns}
        rowKey={(r) => r.id}
        scoped={false}
        selectable
        searchPlaceholder="Search BR no., purpose, project, requester…"
        onRowClick={(r) => navigate(`/g-ops/budget-requests/${r.id}`)}
        emptyTitle="No cash out yet"
        emptyHint="A budget request appears here once finance releases its cash."
        filters={[
          {
            key: 'status',
            label: 'Status',
            options: STATUSES.filter((st) => ['RELEASED', 'REFUND_DUE', 'LIQUIDATED'].includes(st.value)),
          },
          { key: 'overdue', label: 'Liquidation', options: [{ value: 'true', label: 'Overdue only' }] },
          { key: 'requestedById', label: 'Requester', options: people.map((p) => ({ value: p.id, label: p.name })) },
          {
            key: 'teamId',
            label: 'Team',
            options: [...teams.map((t) => ({ value: t.id, label: `${t.code} — ${t.name}` })), { value: 'none', label: 'No team' }],
          },
        ]}
        summary={(raw) => {
          const sum = raw as unknown as RequestsSummary | undefined;
          if (!sum) return null;
          return (
            <>
              <Stat
                label="Sum of all liquidation accounts"
                value={formatMoney(sum.released)}
                figure
                sub={`Released · ${formatMoney(sum.spent)} spent on the liquidated`}
              />
              <Stat label="Total excess returned" value={formatMoney(sum.returned)} figure accent="ok" sub="unspent cash handed back" />
              <Stat
                label="Still owed back"
                value={formatMoney(sum.owedBack)}
                figure
                accent={sum.owedBack > 0 ? 'warn' : undefined}
                sub={`${sum.refundDueCount} to process`}
                to="/g-fin/budget-liquidations?status=REFUND_DUE"
              />
            </>
          );
        }}
      />
    </div>
  );
}

// ── The project's tab ────────────────────────────────────────────────────────

/**
 * The project's budget requests, as its tab shows them: what was asked,
 * released, spent and returned, when the receipts are due, and each one's
 * approval chain on demand — so the PM can see who is sitting on it.
 */
/** "Sales order GT-SO-…" with its name, as a register cell says what a request is for. */
function ForLabel({ source }: { source: RequestSource }) {
  return (
    <>
      {source.kind !== 'project' && <>{SOURCE_WORDS[source.kind]} </>}
      <span className="mono">{source.number}</span> {source.name}
    </>
  );
}

export function ProjectBudgetRequestsCard({
  job,
  record,
  reloadToken,
  onRaise,
}: {
  job?: { id: string };
  /**
   * A sales order's, quotation's or costing's own requests (2026-10-26) —
   * the same card on its page, in place of a project's.
   */
  record?: { key: 'salesOrderId' | 'quotationId' | 'costingId'; id: string };
  reloadToken: number;
  onRaise?: () => void;
}) {
  const filterKey = record?.key ?? 'jobId';
  const filterId = record?.id ?? job?.id ?? '';
  const [rows, setRows] = useState<BudgetRequest[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [open, setOpen] = useState<string | null>(null);

  useEffect(() => {
    api
      .get<ListResult<BudgetRequest>>(`/budget-requests?${filterKey}=${filterId}&pageSize=100`)
      .then((r) => setRows(r.rows))
      .catch(setError);
  }, [filterKey, filterId, reloadToken]);

  const sum = (pick: (r: BudgetRequest) => number) => (rows ?? []).reduce((s, r) => s + pick(r), 0);
  const live = (rows ?? []).filter((r) => !['REJECTED', 'CANCELLED', 'DRAFT'].includes(r.status));

  return (
    <section className="card">
      <div className="card-head">
        <h3 className="card-title">Budget requests{rows && rows.length ? ` (${rows.length})` : ''}</h3>
        {onRaise && (
          <button className="btn btn-primary btn-sm" onClick={onRaise}>
            + New budget request
          </button>
        )}
      </div>
      <p className="muted del-lede">
        Cash for the team to buy what it needs without a purchase requisition. The team leader, back
        support and the finance manager allow it, finance releases it, and it is liquidated with receipts in Expenses —{' '}
        {record
          ? 'checked against this record’s own cost; a project built from it takes the requests over.'
          : 'released cash shows as committed on its budget line, and the liquidation turns what was spent into incurred.'}
      </p>
      <ErrorBox error={error} />
      {!rows && !error ? (
        <Loading />
      ) : rows && rows.length === 0 ? (
        <p className="faint del-note">No budget requests raised on this {record ? (record.key === 'salesOrderId' ? 'sales order' : record.key === 'quotationId' ? 'quotation' : 'costing') : 'project'}.</p>
      ) : rows ? (
        <>
          <dl className="kv del-br-sum">
            <dt>Requested</dt>
            <dd className="mono">{formatMoney(live.reduce((s, r) => s + r.amount, 0))}</dd>
            <dt>Released</dt>
            <dd className="mono">{formatMoney(sum((r) => r.amountReleased))}</dd>
            <dt>Spent</dt>
            <dd className="mono">{formatMoney(sum((r) => r.spent))}</dd>
            <dt>Out with the team</dt>
            <dd className="mono">{formatMoney(sum((r) => (r.status === 'RELEASED' ? r.amountReleased : r.refundOutstanding)))}</dd>
          </dl>
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Number</th>
                  <th>Purpose</th>
                  <th>Budget line</th>
                  <th>Raised by</th>
                  <th className="right">Amount</th>
                  <th className="right">Released</th>
                  <th className="right">Spent</th>
                  <th>Liquidate by</th>
                  <th>Status</th>
                  <th>
                    <span className="visually-hidden">Approval</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const chained = r.status !== 'DRAFT';
                  const expanded = open === r.id;
                  return (
                    <RowGroup key={r.id}>
                      <tr>
                        <td>
                          <Link to={`/g-ops/budget-requests/${r.id}`} className="mono">
                            {r.number}
                          </Link>
                        </td>
                        <td>
                          {r.reason}
                          {r.liquidation && (
                            <div className="faint">
                              Liquidation{' '}
                              <Link to={`/g-fin/expenses/${r.liquidation.id}`} className="mono">
                                {r.liquidation.number}
                              </Link>{' '}
                              · {humanise(r.liquidation.status)}
                            </div>
                          )}
                        </td>
                        <td>{r.officeBudgetLine ? `${r.officeBudgetLine.code} ${r.officeBudgetLine.name}` : r.costCategory.name}</td>
                        <td>
                          {r.requestedBy.name}
                          <div className="faint">{formatDate(r.createdAt)}</div>
                        </td>
                        <td className="right mono">{formatMoney(r.amount)}</td>
                        <td className="right mono">{r.amountReleased > 0 ? formatMoney(r.amountReleased) : <span className="faint">—</span>}</td>
                        <td className="right mono">{r.liquidatedAt ? formatMoney(r.spent) : <span className="faint">—</span>}</td>
                        <td>
                          <Deadline row={r} />
                        </td>
                        <td>
                          <StatusCell row={r} />
                        </td>
                        <td>
                          {chained && (
                            <button
                              type="button"
                              className="btn btn-sm btn-ghost"
                              aria-expanded={expanded}
                              aria-controls={`br-approval-${r.id}`}
                              onClick={() => setOpen(expanded ? null : r.id)}
                            >
                              {expanded ? 'Hide approval' : 'Approval'}
                            </button>
                          )}
                        </td>
                      </tr>
                      {expanded && (
                        <tr className="del-expand-row">
                          <td colSpan={10} id={`br-approval-${r.id}`}>
                            <DocumentApproval documentType="budget_request" documentId={r.id} compact />
                          </td>
                        </tr>
                      )}
                    </RowGroup>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      ) : null}
    </section>
  );
}

/** A row and its expansion share one key without an extra wrapper element. */
function RowGroup({ children }: { children: ReactNode }) {
  return <>{children}</>;
}

// ── One request ──────────────────────────────────────────────────────────────

export function BudgetRequestDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const toast = useToast();
  const { me, can } = useAuth();
  const confirm = useConfirm();
  const [row, setRow] = useState<BudgetRequest | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [reload, setReload] = useState(0);
  const [modal, setModal] = useState<null | 'release' | 'refund'>(null);
  const [booking, setBooking] = useState(false);
  // `?act=liquidate|refund` — Budget Liquidations' "Actual entry" and
  // "Process" land here with the form open, read once and dropped.
  const [params, setParams] = useSearchParams();
  const act = params.get('act');

  /*
    Back goes to the project's Budget Requests tab for the project side, and
    to G-FIN's register for finance, who may not open projects at all.
  */
  const projectSide =
    (can('gops.budget_requests.view_all') || can('gops.budget_requests.view_own')) &&
    (can('gops.projects.view_all') || can('gops.projects.view_own'));
  const financeSide = can('gfin.budget_requests.view_all');
  useBackLink(
    row && projectSide && row.job ? `/g-ops/projects/${row.job.id}?tab=requests` : row && (projectSide || !financeSide) && row.for ? row.for.link : row && financeSide ? '/g-fin/budget-requests' : null,
    row && projectSide && row.job ? `${row.job.number} Budget Requests` : row && (projectSide || !financeSide) && row.for ? row.for.number : row && financeSide ? 'Budget Requests' : null,
  );

  const load = useCallback(async () => {
    try {
      setRow(await api.get<BudgetRequest>(`/budget-requests/${id}`));
    } catch (err) {
      setError(err);
    }
  }, [id]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    if (!row || !act) return;
    if (act === 'refund') setModal(act);
    // The liquidation is a page of its own now (2026-10-19).
    if (act === 'liquidate') navigate(`/g-fin/expenses/new?budgetRequest=${row.id}`);
    const next = new URLSearchParams(params);
    next.delete('act');
    setParams(next, { replace: true });
  }, [row, act, params, setParams, navigate]);

  if (error && !row) return <ErrorBox error={error} />;
  if (!row) return <Loading />;

  const own = row.requestedBy.id === me?.user.id;
  const superAdmin = !!me?.user.isSuperAdmin;
  const editAll = superAdmin || can('gops.budget_requests.edit_all');
  const canModify = !!row.canEdit;
  const canSubmit = row.status === 'DRAFT' && (own || superAdmin);
  const canCancel =
    (row.status === 'DRAFT' || row.status === 'PENDING_APPROVAL' || (row.status === 'APPROVED' && row.amountReleased <= 0)) &&
    (own || editAll);
  const canLiquidate = row.status === 'RELEASED' && !row.liquidation && (own || superAdmin) && can('gfin.expenses.create');
  const seePayments = can('gfin.payments.view_all') || can('gfin.ap.view_all') || can('gfin.ar.view_all');
  const route = row.approvalRoute;

  const done = () => {
    setModal(null);
    setBooking(false);
    setReload((r) => r + 1);
    load();
  };

  async function submit() {
    try {
      await api.post(`/budget-requests/${id}/submit`);
      toast('ok', 'Sent for approval');
      done();
    } catch (err) {
      setError(err);
    }
  }

  /** Asked in the confirm bar first; a refusal is shown there. */
  async function cancel(reason: string) {
    await api.post(`/budget-requests/${id}/cancel`, { reason: reason || null });
    toast('ok', 'Cancelled');
    done();
  }

  async function remove() {
    await api.del(`/budget-requests/${id}`);
    toast('ok', `${row!.number} deleted`);
    navigate(-1);
  }

  return (
    <div>
      <RecordHeader
        type={row.isTravel ? 'Travel Request' : 'Budget Request'}
        code={row.number}
        title={row.reason}
        status={row.liquidationOverdue ? 'OVERDUE' : row.status}
        statusExtra={BUDGET_REQUEST_TONES}
        amount={formatMoney(row.amount)}
        amountLabel="Requested"
        meta={
          <>
            Requested by {row.requestedBy.name} on {formatDate(row.createdAt)}
            {row.neededBy && <> · needed by {formatDate(row.neededBy)}</>}
            {' · for '}
            {row.for ? <Link to={row.for.link}>{row.for.label}</Link> : '—'}
            {!row.officeBudgetLine && <> · {row.costCategory.name}</>}
            {row.job?.projectManager && <> · Technical Manager {row.job.projectManager.name}</>}
            {row.job && row.raisedOn && <> · raised on <Link to={row.raisedOn.link}>{row.raisedOn.label}</Link></>}
          </>
        }
        actions={
          <>
            {canSubmit && (
              <button className="btn btn-primary" onClick={submit}>
                Submit for approval
              </button>
            )}
            {row.canBook && !booking && (
              <button className="btn btn-primary" onClick={() => setBooking(true)}>
                Book and pay directly
              </button>
            )}
            {row.status === 'APPROVED' && row.toRelease > 0 && can('gfin.ap.create') && (
              <button className={row.canBook ? 'btn' : 'btn btn-primary'} onClick={() => setModal('release')}>
                Release cash
              </button>
            )}
            {canLiquidate && (
              <button className="btn btn-primary" onClick={() => navigate(`/g-fin/expenses/new?budgetRequest=${row.id}`)}>
                Liquidate
              </button>
            )}
            {row.status === 'REFUND_DUE' && row.refundOutstanding > 0 && can('gfin.ar.create') && (
              <button className="btn btn-primary" onClick={() => setModal('refund')}>
                Record refund
              </button>
            )}
          </>
        }
        print={`/api/budget-requests/${row.id}/pdf`}
        more={[
          canCancel && {
            label: row.isTravel ? 'Cancel travel request' : 'Cancel budget request',
            danger: true,
            confirm: {
              title: `Cancel ${row.number}?`,
              body:
                row.status === 'PENDING_APPROVAL'
                  ? 'The approval request is withdrawn with it, and the approvers are told.'
                  : row.status === 'APPROVED'
                    ? 'Nothing has been released, so nothing needs to come back.'
                    : 'Nothing has been approved or released yet.',
              confirmLabel: row.isTravel ? 'Cancel travel request' : 'Cancel budget request',
              reason: 'optional',
              reasonLabel: 'Why? Kept on the request',
              onConfirm: cancel,
            },
          },
          (row.status === 'DRAFT' || row.status === 'CANCELLED') &&
            can('gops.budget_requests.delete') && {
              label: 'Delete',
              danger: true,
              confirm: {
                title: `Delete ${row.number}?`,
                body: `This ${row.status === 'CANCELLED' ? 'cancelled request' : 'draft'} goes for good. Its number is not reused.`,
                confirmLabel: 'Delete',
                onConfirm: remove,
              },
            },
        ]}
        modify={canModify ? `/g-ops/budget-requests/${row.id}/edit` : undefined}
        confirm={confirm}
      />

      {row.status === 'DRAFT' && route && route.steps.length > 0 && (
        <div className="qd-route">
          <span className="qd-route-label">Submit for approval sends it to</span>
          <ApprovalStepper
            steps={route.steps.map((st) => ({
              label: st.name,
              approver: st.approvers.length ? st.approvers.map((p) => p.name).join(' or ') : 'Nobody — no one else holds this role',
              status: 'WAITING',
            }))}
          />
        </div>
      )}
      <DecisionNote documentType={row.approvalType ?? 'budget_request'} documentId={row.id} reloadToken={reload} />
      {row.status !== 'DRAFT' && <DocumentApproval documentType={row.approvalType ?? 'budget_request'} documentId={row.id} reloadToken={reload} />}
      {booking && row.canBook && <BookTravelPanel row={row} onDone={done} onCancel={() => setBooking(false)} />}
      {row.isTravel && (
        <div className="card">
          <h3 className="card-title">Journey</h3>
          <dl className="kv">
            <dt>Travel by</dt>
            <dd>{TRAVEL_MODE_WORDS[row.travelMode ?? ''] ?? '—'}</dd>
            <dt>Route</dt>
            <dd>
              {row.travelFrom} → {row.travelTo}
            </dd>
            <dt>Departure</dt>
            <dd>{row.departOn ? formatDate(row.departOn) : '—'}</dd>
            <dt>Return</dt>
            <dd>{row.returnOn ? formatDate(row.returnOn) : 'One way'}</dd>
            {row.carrier && (
              <>
                <dt>Carrier</dt>
                <dd>{row.carrier}</dd>
              </>
            )}
            {row.travellers && (
              <>
                <dt>Travellers / cargo</dt>
                <dd>{row.travellers}</dd>
              </>
            )}
          </dl>
        </div>
      )}
      {row.budget && <RequestBudgetCard budget={row.budget} lineName={row.budget.source === 'office' ? (row.budget.line?.name ?? '') : row.costCategory.name} />}

      <ErrorBox error={error} />

      {row.status === 'DRAFT' && <div className="alert info">A draft. Nothing happens until it is submitted for approval.</div>}
      {row.status === 'PENDING_APPROVAL' && (
        <div className="alert info">Waiting for approval — the Approval panel says with whom. Nothing is charged to the project until it is liquidated.</div>
      )}
      {row.status === 'APPROVED' && (
        <div className="alert info">
          {row.isTravel
            ? `Approved. Finance either books and pays the trip directly (the company card — nothing to liquidate) or releases ${formatMoney(row.toRelease)} in one voucher.`
            : `Approved. Finance releases ${formatMoney(row.toRelease)} in one voucher. Nothing is charged to the project until the receipts are in.`}
        </div>
      )}
      {row.status === 'RELEASED' && !row.liquidation && (
        <div className={`alert ${row.liquidationOverdue ? 'warn' : 'info'}`}>
          {formatMoney(row.amountReleased)} released
          {row.releasedAt && <> on {formatDate(row.releasedAt)}</>}.{' '}
          {row.liquidationOverdue
            ? `The receipts were due on ${formatDate(row.liquidationDueDate)} — ${Math.abs(row.daysToLiquidate ?? 0)} days ago.`
            : row.liquidationDueDate
              ? `File the receipts as a liquidation, in Expenses, by ${formatDate(row.liquidationDueDate)}.`
              : 'File the receipts as a liquidation, in Expenses.'}
        </div>
      )}
      {row.status === 'RELEASED' && row.liquidation && (
        <div className="alert info">
          Being liquidated by{' '}
          <Link to={`/g-fin/expenses/${row.liquidation.id}`} className="mono">
            {row.liquidation.number}
          </Link>{' '}
          ({humanise(row.liquidation.status)}). The figures below settle when it is approved.
        </div>
      )}
      {row.status === 'REFUND_DUE' && (
        <div className="alert warn">
          Liquidated at {formatMoney(row.spent)}. {formatMoney(row.refundOutstanding)} of unspent cash is owed back to finance.
        </div>
      )}
      {row.status === 'LIQUIDATED' && (
        <div className="alert ok">
          {row.paidDirect ? 'Booked and paid directly by finance — nothing to liquidate.' : 'Liquidated.'} {formatMoney(row.spent)} spent{row.job ? <> and charged to {row.job.number}</> : <> against {row.for?.label}</>}
          {row.excessDue > 0 && <>; the {formatMoney(row.excessDue)} over the cash released is reimbursed on the liquidation</>}
          {row.amountRefunded > 0 && <>; {formatMoney(row.amountRefunded)} of unspent cash came back</>}.
        </div>
      )}
      {row.status === 'CANCELLED' && row.cancelReason && <div className="alert warn">Cancelled — {row.cancelReason}</div>}

      <RequestItemsCard items={row.items ?? []} total={row.amount} />

      <div className="grid grid-2">
        <div className="card">
          <h3 className="card-title">The money</h3>
          <dl className="kv fin-settlement">
            <dt>Requested</dt>
            <dd className="mono">{formatMoney(row.amount)}</dd>
            <dt>Released</dt>
            <dd className="mono">{row.amountReleased > 0 ? formatMoney(row.amountReleased) : <span className="faint">not yet</span>}</dd>
            <dt>Liquidate by</dt>
            <dd>
              <Deadline row={row} />
            </dd>
            <dt>Spent</dt>
            <dd className="mono">{row.liquidatedAt ? formatMoney(row.spent) : <span className="faint">not yet liquidated</span>}</dd>
            {row.liquidatedAt && row.excessDue > 0 && (
              <>
                <dt>Over the cash released — owed to {row.requestedBy.name}</dt>
                <dd className="mono fin-settlement-total">{formatMoney(row.excessDue)}</dd>
              </>
            )}
            {row.liquidatedAt && row.excessDue <= 0 && (
              <>
                <dt>Unspent — owed back</dt>
                <dd className="mono">{formatMoney(row.refundDue)}</dd>
                <dt>Returned</dt>
                <dd className="mono">{formatMoney(row.amountRefunded)}</dd>
                <dt>Still to come back</dt>
                <dd className="mono fin-settlement-total">{formatMoney(row.refundOutstanding)}</dd>
              </>
            )}
          </dl>
          {row.notes && (
            <p className="muted fin-gap-top fin-flush">
              <strong>Notes.</strong> {row.notes}
            </p>
          )}
        </div>

        <div>
          <div className="card">
            <h3 className="card-title">Liquidation</h3>
            {row.liquidations.length === 0 ? (
              <p className="muted fin-flush">
                {row.status === 'RELEASED' ? 'No receipts filed yet.' : 'Filed in Expenses once the cash has been released and spent.'}
              </p>
            ) : (
              <div className="table-wrap">
                <table className="data">
                  <tbody>
                    {row.liquidations.map((l) => (
                      <tr key={l.id}>
                        <td>
                          <Link to={`/g-fin/expenses/${l.id}`} className="mono">
                            {l.number}
                          </Link>
                          <div className="faint">{formatDate(l.claimDate)}</div>
                        </td>
                        <td>
                          <StatusBadge status={l.status} extra={CLAIM_TONES} />
                        </td>
                        <td className="right mono">{formatMoney(l.total)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          <div className="card">
            <h3 className="card-title">Payments</h3>
            {!row.allocations?.length ? (
              <p className="muted fin-flush">Nothing released yet.</p>
            ) : (
              <div className="table-wrap">
                <table className="data">
                  <tbody>
                    {row.allocations.map((a) => (
                      <tr key={a.id}>
                        <td>
                          {seePayments ? (
                            <Link to={paymentLink(a.payment.id)} className="mono">
                              {a.payment.number}
                            </Link>
                          ) : (
                            <span className="mono">{a.payment.number}</span>
                          )}
                          <div className="faint">
                            {a.payment.kind === 'RECEIPT' ? 'returned' : 'released'} · {formatDate(a.payment.paymentDate)} ·{' '}
                            {humanise(a.payment.method)}
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

      <Attachments
        entityType="budget_request"
        entityId={row.id}
        hint="Quotations, a breakdown or anything the approvers need to check the request. Printed behind the request."
        // Changed while it is a draft or with the approvers, by whoever may modify it.
        canEdit={(row.status === 'DRAFT' || row.status === 'PENDING_APPROVAL') && ((own && can('gops.budget_requests.edit_own')) || editAll)}
      />

      {modal === 'release' && (
        <RecordPaymentModal
          kind="DISBURSEMENT"
          party={{ id: row.requestedBy.id, name: row.requestedBy.name }}
          target={{ kind: 'budget_request', id: row.id, number: row.number, outstanding: row.toRelease }}
          onClose={() => setModal(null)}
          onSaved={done}
        />
      )}

      {modal === 'refund' && (
        <RecordPaymentModal
          kind="RECEIPT"
          party={{ id: row.requestedBy.id, name: row.requestedBy.name }}
          target={{ kind: 'budget_request_refund', id: row.id, number: row.number, outstanding: row.refundOutstanding }}
          onClose={() => setModal(null)}
          onSaved={done}
        />
      )}

    </div>
  );
}

/**
 * A sales order's, quotation's or costing's own budget requests (2026-10-26,
 * the owner's call), with "+ New budget request" while the record may take
 * one (an issued order, an open or won quotation, a final costing). Hidden
 * from whoever may not read the register, as every cross-module card is.
 */
export function RecordBudgetRequests({
  record,
  open,
  wrapClassName,
}: {
  record: { key: 'salesOrderId' | 'quotationId' | 'costingId'; id: string };
  /** A wrapper's class where the page spaces its cards itself. */
  wrapClassName?: string;
  /** The record may take a new request now. */
  open: boolean;
}) {
  const { can } = useAuth();
  const navigate = useNavigate();
  const reads =
    can('gops.budget_requests.view_all') || can('gops.budget_requests.view_own') || can('gfin.budget_requests.view_all') || can('gfin.budget_liquidations.view_all');
  if (!reads) return null;
  const card = (
    <ProjectBudgetRequestsCard
      record={record}
      reloadToken={0}
      onRaise={open && can('gops.budget_requests.create') ? () => navigate(`/g-ops/budget-requests/new?${record.key}=${record.id}`) : undefined}
    />
  );
  return wrapClassName ? <div className={wrapClassName}>{card}</div> : card;
}
