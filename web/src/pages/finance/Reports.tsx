import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, qs } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import {
  Empty,
  ErrorBox,
  Field,
  Loading,
  formatDate,
  formatMoney,
  humanise,
  useToast,
} from '../../components/ui';
import { BarList, Donut, Meter, Panel, Stat, type Slice } from '../../components/charts';
import { IconBadge } from '../../components/Icon';
import { NumberInput } from '../../components/NumberInput';
import { ReportPage, type ReportKind } from '../../components/ReportPage';
import { CustomerPicker, type CustomerRef } from '../../components/CustomerPicker';
import { SupplierPicker, type SupplierRef } from '../../components/SupplierPicker';
import { PersonSelect, usePeople } from '../../components/People';
import { useTeams } from './Receivables';

/** Money arrives as a float; round to centavos before it is charted. */
const cents = (n: number) => Math.round(n * 100) / 100;

/**
 * The finance reports and the executive dashboard.
 *
 * Everything here reads straight off the documents, so it cannot disagree with
 * them. The one thing to keep in mind on every screen: outstanding is measured
 * against NET COLLECTIBLE. The withheld EWT gets its own line because it is
 * real money — it just comes back as a tax certificate rather than as cash.
 */

// ── Executive dashboard ──────────────────────────────────────────────────────

interface Dashboard {
  asOf: string;
  receivable: number;
  receivableOverdue: number;
  payable: number;
  payableOverdue: number;
  reimbursable: number;
  /** Approved and not yet handed over — counted against the position already. */
  advancesToRelease: number;
  /** Released and not yet accounted for by a liquidation. */
  advancesInHand: number;
  /** The same two figures for project cash — budget requests. */
  budgetRequestsToRelease: number;
  budgetRequestsInHand: number;
  workingPosition: number;
  collectedThisMonth: number;
  collectedThisYear: number;
  invoicedThisYear: number;
  withheldAwaitingCertificate: number;
  queue: {
    billingsAwaitingInvoice: number;
    receivingsAwaitingBill: number;
    advancesAwaitingRelease: number;
    liquidationsOverdue: number;
    refundsAwaitingReceipt: number;
    budgetRequestsAwaitingRelease: number;
    budgetLiquidationsOverdue: number;
    budgetRefundsAwaitingReceipt: number;
  };
  activeJobs: number;
}

export function FinanceDashboard() {
  const [data, setData] = useState<Dashboard | null>(null);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    api.get<Dashboard>('/finance-reports/dashboard').then(setData).catch(setError);
  }, []);

  if (error) return <ErrorBox error={error} />;
  if (!data) return <Loading label="Adding it up…" />;

  const tiles = [
    {
      label: 'Receivable',
      icon: 'money-in' as const,
      more: 'Open A/R',
      value: data.receivable,
      sub: data.receivableOverdue > 0 ? `${formatMoney(data.receivableOverdue)} overdue` : 'nothing overdue',
      accent: data.receivableOverdue > 0 ? ('warn' as const) : ('ok' as const),
      to: '/g-fin/ar?outstanding=true',
    },
    {
      label: 'Payable',
      icon: 'money-out' as const,
      more: 'Open A/P',
      value: data.payable,
      sub: data.payableOverdue > 0 ? `${formatMoney(data.payableOverdue)} overdue` : 'nothing overdue',
      accent: data.payableOverdue > 0 ? ('danger' as const) : ('quiet' as const),
      to: '/g-fin/ap?outstanding=true',
    },
    {
      label: 'Owed to staff',
      icon: 'people' as const,
      more: 'Open claims',
      value: data.reimbursable,
      sub: 'approved claims not yet reimbursed',
      accent: 'info' as const,
      to: '/g-fin/expenses?status=APPROVED',
    },
    {
      label: 'Working position',
      icon: 'balance' as const,
      more: 'Open cash flow',
      value: data.workingPosition,
      sub: 'receivable less everything owed, advances included',
      accent: data.workingPosition < 0 ? ('danger' as const) : ('ok' as const),
      to: '/g-fin/cash-flow',
    },
  ];

  // Every figure below is read off the documents themselves. Nothing on this
  // screen writes anything — one GET, and the router it comes from is
  // read-only by construction.
  const owed: Slice[] = [
    {
      label: 'Customers owe us',
      value: data.receivable,
      display: formatMoney(data.receivable),
      tone: 'neon',
      to: '/g-fin/ar?outstanding=true',
    },
    {
      label: 'We owe suppliers',
      value: data.payable,
      display: formatMoney(data.payable),
      tone: 'danger',
      to: '/g-fin/ap?outstanding=true',
    },
    {
      label: 'We owe staff',
      value: data.reimbursable,
      display: formatMoney(data.reimbursable),
      tone: 'info',
      to: '/g-fin/expenses?status=APPROVED',
    },
    // An approved advance is cash promised; the working position counts it
    // before the voucher exists, so the chart shows it too.
    {
      label: 'Advances approved, not yet released',
      value: data.advancesToRelease,
      display: formatMoney(data.advancesToRelease),
      tone: 'warn',
      to: '/g-fin/cash-advances?status=APPROVED',
    },
  ];

  // Receivable splits exactly two ways, so it is a genuine whole — which is
  // the only thing a doughnut may be used for.
  const receivableCurrent = cents(data.receivable - data.receivableOverdue);
  const ageing: Slice[] = [
    {
      label: 'Not yet due',
      value: receivableCurrent,
      display: formatMoney(receivableCurrent),
      tone: 'neon',
      to: '/g-fin/ar?outstanding=true',
    },
    {
      label: 'Overdue',
      value: data.receivableOverdue,
      display: formatMoney(data.receivableOverdue),
      tone: 'danger',
      to: '/g-fin/ar?overdue=true',
    },
  ];

  const collectedPct =
    data.invoicedThisYear > 0 ? (data.collectedThisYear / data.invoicedThisYear) * 100 : 0;

  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <h1>Executive Dashboard</h1>
          <p>
            Where the money is, as of {formatDate(data.asOf)}. Every figure is read off the
            documents themselves — nothing here is keyed separately, so nothing here can disagree
            with them.
          </p>
        </div>
      </div>

      {/* `figure` sets these in Inter rather than Orbitron: these are pesos
          with thousands separators, and the display face has no useful comma. */}
      <div className="kpi-grid">
        {tiles.map((t) => (
          <Stat
            key={t.label}
            label={t.label}
            value={formatMoney(t.value)}
            sub={t.sub}
            accent={t.accent}
            icon={t.icon}
            more={t.more}
            figure
            to={t.to}
          />
        ))}
      </div>

      <div className="grid grid-2">
        <Panel
          title="What we are owed, against what we owe"
          blurb="Scaled against the largest of the three. Every bar carries its own amount, so the lengths rank them and the figures say what they are."
          action={
            <Link to="/g-fin/cash-flow" className="btn btn-sm">
              Cash flow
            </Link>
          }
        >
          <BarList slices={owed} caption="Outstanding on both sides, today" />
          <p className="panel-blurb">
            Working position is {formatMoney(data.workingPosition)} —{' '}
            {data.workingPosition < 0
              ? 'we owe more than we are owed.'
              : 'what customers owe us, less everything we owe.'}
          </p>
          <div className="grid grid-2">
            <Stat
              label="Advances to release"
              value={formatMoney(data.advancesToRelease)}
              sub={`${data.queue.advancesAwaitingRelease} approved, waiting on finance`}
              figure
              accent={data.advancesToRelease > 0 ? 'warn' : 'quiet'}
              to="/g-fin/cash-advances?status=APPROVED"
            />
            <Stat
              label="Cash out with staff"
              value={formatMoney(data.advancesInHand)}
              sub="released, not yet accounted for"
              figure
              accent={data.queue.liquidationsOverdue > 0 ? 'danger' : 'info'}
              to="/g-fin/cash-advances?status=RELEASED"
            />
            <Stat
              label="Project cash to release"
              value={formatMoney(data.budgetRequestsToRelease)}
              sub={`${data.queue.budgetRequestsAwaitingRelease} budget request${data.queue.budgetRequestsAwaitingRelease === 1 ? '' : 's'} approved, waiting on finance`}
              figure
              accent={data.budgetRequestsToRelease > 0 ? 'warn' : 'quiet'}
              to="/g-fin/budget-requests?status=APPROVED"
            />
            <Stat
              label="Project cash with the teams"
              value={formatMoney(data.budgetRequestsInHand)}
              sub="released, not yet accounted for"
              figure
              accent={data.queue.budgetLiquidationsOverdue > 0 ? 'danger' : 'info'}
              to="/g-fin/budget-requests?status=RELEASED"
            />
          </div>
        </Panel>

        <Panel
          title="Collected against invoiced"
          blurb="Cleared money only. An uncleared cheque is a promise, and a cash position that counts promises is the one that bounces."
        >
          <div className="series-legend">
            <div className="series">
              <span className="series-name">
                <span className="series-dot" style={{ background: 'var(--neon)' }} />
                Collected this year
              </span>
              <span className="series-value">{formatMoney(data.collectedThisYear)}</span>
            </div>
            <div className="series">
              <span className="series-name">
                <span className="series-dot" style={{ background: 'var(--muted)' }} />
                Invoiced this year
              </span>
              <span className="series-value">{formatMoney(data.invoicedThisYear)}</span>
            </div>
          </div>

          <Meter pct={collectedPct} tone={collectedPct < 70 ? 'warn' : undefined} />
          <p className="panel-blurb">
            {formatMoney(data.collectedThisYear)} collected of{' '}
            {formatMoney(data.invoicedThisYear)} invoiced this year —{' '}
            <strong>{collectedPct.toFixed(1)}%</strong>. The rest is still outstanding, not lost.
          </p>
          <div className="grid grid-2">
            <Stat
              label="Collected this month"
              value={formatMoney(data.collectedThisMonth)}
              sub="cleared into the bank"
              figure
              accent="ok"
              to="/g-fin/payments"
            />
            <Stat
              label="Active projects"
              value={data.activeJobs}
              sub="billing against them"
              accent="info"
              to="/g-ops/projects?status=IN_PROGRESS"
            />
          </div>
        </Panel>
      </div>

      <div className="grid grid-2">
        <Panel
          title="Receivable, by age"
          blurb="Outstanding measured against NET COLLECTIBLE, never the invoice total — EWT is withheld at source, so invoiced is not collectible and the withheld part must never read as overdue."
        >
          <Donut
            slices={ageing}
            caption="Every peso customers owe, split by whether its terms have run out"
            centreLabel="receivable"
            centreValue={formatMoney(data.receivable)}
          />
        </Panel>

        <Panel
          title="Waiting on someone"
          blurb="Work that is finished but has not turned into a document yet. Each one is money that cannot move until somebody raises the paperwork."
        >
          <ul className="icon-list">
            <li>
              <Link to="/g-fin/ar" className="icon-row">
                <IconBadge name="invoice" accent="warn" size={32} />
                <span className="icon-row-body">
                  <span className="icon-row-title">Approved billings not yet invoiced</span>
                  <span className="icon-row-sub">Nothing can be collected until they are raised</span>
                </span>
                <span className="icon-row-value">{data.queue.billingsAwaitingInvoice}</span>
              </Link>
            </li>
            <li>
              <Link to="/g-fin/ap" className="icon-row">
                <IconBadge name="box" accent="warn" size={32} />
                <span className="icon-row-body">
                  <span className="icon-row-title">Goods received with no supplier bill</span>
                  <span className="icon-row-sub">Already a cost to the job; not yet a payable</span>
                </span>
                <span className="icon-row-value">{data.queue.receivingsAwaitingBill}</span>
              </Link>
            </li>
            <li>
              <Link to="/g-fin/cash-advances?status=APPROVED" className="icon-row">
                <IconBadge name="money-out" accent={data.queue.advancesAwaitingRelease > 0 ? 'warn' : 'quiet'} size={32} />
                <span className="icon-row-body">
                  <span className="icon-row-title">Cash advances approved, not yet released</span>
                  <span className="icon-row-sub">Somebody is waiting on finance for the cash</span>
                </span>
                <span className="icon-row-value">{data.queue.advancesAwaitingRelease}</span>
              </Link>
            </li>
            <li>
              <Link to="/g-fin/cash-advances?overdue=true" className="icon-row">
                <IconBadge name="people" accent={data.queue.liquidationsOverdue > 0 ? 'danger' : 'quiet'} size={32} />
                <span className="icon-row-body">
                  <span className="icon-row-title">Liquidations overdue</span>
                  <span className="icon-row-sub">Cash released and past its deadline with no receipts</span>
                </span>
                <span className="icon-row-value">{data.queue.liquidationsOverdue}</span>
              </Link>
            </li>
            <li>
              <Link to="/g-fin/cash-advances?status=REFUND_DUE" className="icon-row">
                <IconBadge name="money-in" accent={data.queue.refundsAwaitingReceipt > 0 ? 'warn' : 'quiet'} size={32} />
                <span className="icon-row-body">
                  <span className="icon-row-title">Unspent advance money not yet returned</span>
                  <span className="icon-row-sub">Liquidated, and the change is still with the person</span>
                </span>
                <span className="icon-row-value">{data.queue.refundsAwaitingReceipt}</span>
              </Link>
            </li>
            <li>
              <Link to="/g-fin/budget-requests?status=APPROVED" className="icon-row">
                <IconBadge name="money-out" accent={data.queue.budgetRequestsAwaitingRelease > 0 ? 'warn' : 'quiet'} size={32} />
                <span className="icon-row-body">
                  <span className="icon-row-title">Budget requests approved, not yet released</span>
                  <span className="icon-row-sub">A project team is waiting on finance for the cash</span>
                </span>
                <span className="icon-row-value">{data.queue.budgetRequestsAwaitingRelease}</span>
              </Link>
            </li>
            <li>
              <Link to="/g-fin/budget-requests?overdue=true" className="icon-row">
                <IconBadge name="people" accent={data.queue.budgetLiquidationsOverdue > 0 ? 'danger' : 'quiet'} size={32} />
                <span className="icon-row-body">
                  <span className="icon-row-title">Budget request liquidations overdue</span>
                  <span className="icon-row-sub">Project cash released and past its deadline with no receipts</span>
                </span>
                <span className="icon-row-value">{data.queue.budgetLiquidationsOverdue}</span>
              </Link>
            </li>
            <li>
              <Link to="/g-fin/budget-requests?status=REFUND_DUE" className="icon-row">
                <IconBadge name="money-in" accent={data.queue.budgetRefundsAwaitingReceipt > 0 ? 'warn' : 'quiet'} size={32} />
                <span className="icon-row-body">
                  <span className="icon-row-title">Unspent project cash not yet returned</span>
                  <span className="icon-row-sub">Liquidated, and the change is still with the team</span>
                </span>
                <span className="icon-row-value">{data.queue.budgetRefundsAwaitingReceipt}</span>
              </Link>
            </li>
            <li>
              <span className="icon-row">
                <IconBadge
                  name="document"
                  accent={data.withheldAwaitingCertificate > 0 ? 'warn' : 'quiet'}
                  size={32}
                />
                <span className="icon-row-body">
                  <span className="icon-row-title">Withheld tax awaiting a BIR 2307</span>
                  <span className="icon-row-sub">Creditable, but only once the certificate arrives</span>
                </span>
                <span className="icon-row-value">
                  {formatMoney(data.withheldAwaitingCertificate)}
                </span>
              </span>
            </li>
          </ul>
          <Link to="/g-fin/reports" className="panel-more">
            All finance reports <span aria-hidden="true">›</span>
          </Link>
        </Panel>
      </div>
    </div>
  );
}

// ── Reports ──────────────────────────────────────────────────────────────────

/**
 * G-FIN › Reports (2026-10-15, the owner's A/R sample: "Create Report" —
 * the aging, receivables, collections — and "Forecast Collection"): one
 * report per money-in and money-out menu on the shared `ReportPage`, the API
 * `routes/finReports.ts`. The A/R reports narrow by sales personnel, team and
 * customer; the forecast reads by week or month.
 */
export const FIN_REPORT_KINDS: readonly ReportKind[] = [
  { key: 'receivables', label: 'Receivables', list: '/g-fin/ar' },
  { key: 'aging', label: 'Receivables aging', list: '/g-fin/ar?outstanding=true', mode: 'asOf' },
  { key: 'collection-forecast', label: 'Collection forecast', list: '/g-fin/ar?outstanding=true', mode: 'ahead' },
  { key: 'collections', label: 'Collections', list: '/g-fin/payments' },
  { key: 'payables', label: 'Accounts payable (by due date)', list: '/g-fin/ap', mode: 'span' },
  { key: 'payables-aging', label: 'Payables aging', list: '/g-fin/ap', mode: 'asOf' },
  { key: 'payments', label: 'Payments out', list: '/g-fin/payments?kind=DISBURSEMENT' },
  { key: 'budget-requests', label: 'Budget requests (by date needed)', list: '/g-fin/budget-requests' },
  { key: 'liquidations', label: 'Budget liquidations', list: '/g-fin/budget-liquidations' },
  { key: 'reimbursements', label: 'Reimbursements', list: '/g-fin/expenses' },
  { key: 'cash-advances', label: 'Cash advances (money lent)', list: '/g-fin/cash-advances' },
];
const AR_KINDS = ['receivables', 'aging', 'collection-forecast', 'collections'];
const REQUEST_KINDS = ['budget-requests', 'liquidations', 'reimbursements', 'cash-advances'];
/** The right each kind needs beside Reports' — the API's `rights`. */
const KIND_RIGHT = (key: string) =>
  AR_KINDS.includes(key)
    ? 'gfin.ar.view_all'
    : key === 'budget-requests'
      ? 'gfin.budget_requests.view_all'
      : key === 'liquidations'
        ? 'gfin.budget_liquidations.view_all'
        : key === 'reimbursements'
          ? 'gfin.expenses.view_all'
          : key === 'cash-advances'
            ? 'gfin.cash_advances.view_all'
            : 'gfin.ap.view_all';
const ADVANCE_STATUSES = ['PENDING_APPROVAL', 'APPROVED', 'RELEASED', 'PAID', 'REFUND_DUE', 'LIQUIDATED', 'REJECTED', 'CANCELLED'];
const CLAIM_STATUSES = ['PENDING_APPROVAL', 'APPROVED', 'REIMBURSED', 'SETTLED', 'REJECTED', 'CANCELLED'];
const REQUEST_STATUSES = ['PENDING_APPROVAL', 'APPROVED', 'RELEASED', 'REFUND_DUE', 'LIQUIDATED', 'REJECTED', 'CANCELLED'];

/** The supplier named in the URL, as the picker shows it. */
function ReportSupplier({ id, onChange }: { id: string | null; onChange: (id: string) => void }) {
  const [value, setValue] = useState<SupplierRef | null>(null);
  useEffect(() => {
    if (!id) return setValue(null);
    if (value?.id === id) return;
    api
      .get<SupplierRef>(`/suppliers/${id}`)
      .then(setValue)
      .catch(() => setValue(null));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);
  return (
    <SupplierPicker
      value={value}
      onChange={(c) => {
        setValue(c);
        onChange(c?.id ?? '');
      }}
    />
  );
}

/** The customer named in the URL, as the picker shows it. */
function ReportCustomer({ id, onChange }: { id: string | null; onChange: (id: string) => void }) {
  const [value, setValue] = useState<CustomerRef | null>(null);
  useEffect(() => {
    if (!id) return setValue(null);
    if (value?.id === id) return;
    api
      .get<CustomerRef>(`/customers/${id}`)
      .then(setValue)
      .catch(() => setValue(null));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);
  return (
    <CustomerPicker
      value={value}
      allowCreate={false}
      onChange={(c) => {
        setValue(c);
        onChange(c?.id ?? '');
      }}
    />
  );
}

export function FinanceReports() {
  const { can } = useAuth();
  const { people } = usePeople('gops.quotations.create');
  const { people: buyers } = usePeople('gchain.purchase_orders.create');
  const { people: requesters } = usePeople('gops.budget_requests.create');
  const { people: claimants } = usePeople('gfin.expenses.create');
  const { people: borrowers } = usePeople('gfin.cash_advances.create');
  const teams = useTeams();
  const kinds = FIN_REPORT_KINDS.filter((k) => can(KIND_RIGHT(k.key)));
  return (
    <ReportPage
      title="Finance Reports"
      endpoint="/fin-reports"
      kinds={kinds.length ? kinds : FIN_REPORT_KINDS}
      extraKeys={['salespersonId', 'teamId', 'customerId', 'by', 'purchaserId', 'supplierId', 'requestedById', 'status']}
      controls={({ kind, params, set }) =>
        REQUEST_KINDS.includes(kind) ? (
          <>
            <span className="rep-label">Narrow to</span>
            <label className="rep-date">
              <span className="faint">Requester</span>
              <PersonSelect
                value={params.get('requestedById') ?? ''}
                onChange={(id) => set({ requestedById: id })}
                people={kind === 'reimbursements' ? claimants : kind === 'cash-advances' ? borrowers : requesters}
                placeholder="— all requesters —"
              />
            </label>
            <label className="rep-date">
              <span className="faint">Team</span>
              <select value={params.get('teamId') ?? ''} onChange={(e) => set({ teamId: e.target.value })}>
                <option value="">— every team —</option>
                {teams.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.code} — {t.name}
                  </option>
                ))}
                <option value="none">No team</option>
              </select>
            </label>
            {kind !== 'liquidations' && (
              <label className="rep-date">
                <span className="faint">Status</span>
                <select value={params.get('status') ?? ''} onChange={(e) => set({ status: e.target.value })}>
                  <option value="">— all statuses —</option>
                  {(kind === 'reimbursements' ? CLAIM_STATUSES : kind === 'cash-advances' ? ADVANCE_STATUSES : REQUEST_STATUSES).map((st) => (
                    <option key={st} value={st}>
                      {humanise(st)}
                    </option>
                  ))}
                </select>
              </label>
            )}
          </>
        ) : kind === 'payables' ? (
          <>
            <span className="rep-label">Narrow to</span>
            <label className="rep-date">
              <span className="faint">Purchaser</span>
              <PersonSelect
                value={params.get('purchaserId') ?? ''}
                onChange={(id) => set({ purchaserId: id })}
                people={buyers}
                placeholder="— all purchasers —"
              />
            </label>
            <div className="rep-date rep-customer">
              <span className="faint">Supplier / Vendor</span>
              <ReportSupplier id={params.get('supplierId')} onChange={(id) => set({ supplierId: id })} />
            </div>
          </>
        ) : AR_KINDS.includes(kind) ? (
          <>
            <span className="rep-label">Narrow to</span>
            <label className="rep-date">
              <span className="faint">Sales personnel</span>
              <PersonSelect
                value={params.get('salespersonId') ?? ''}
                onChange={(id) => set({ salespersonId: id })}
                people={people}
                placeholder="— everyone —"
              />
            </label>
            <label className="rep-date">
              <span className="faint">Team</span>
              <select value={params.get('teamId') ?? ''} onChange={(e) => set({ teamId: e.target.value })}>
                <option value="">— every team —</option>
                {teams.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.code} — {t.name}
                  </option>
                ))}
                <option value="none">No team</option>
              </select>
            </label>
            <div className="rep-date rep-customer">
              <span className="faint">Customer</span>
              <ReportCustomer id={params.get('customerId')} onChange={(id) => set({ customerId: id })} />
            </div>
            {kind === 'collection-forecast' && (
              <div className="scope-switch" role="group" aria-label="By">
                {(['month', 'week'] as const).map((b) => (
                  <button
                    key={b}
                    type="button"
                    className={(params.get('by') ?? 'month') === b ? 'active' : ''}
                    aria-pressed={(params.get('by') ?? 'month') === b}
                    onClick={() => set({ by: b === 'month' ? '' : b })}
                  >
                    By {b}
                  </button>
                ))}
              </div>
            )}
          </>
        ) : null
      }
    />
  );
}

interface CashFlow {
  months: { month: string; in: number; out: number; net: number }[];
  forecast: { label: string; in: number; out: number; net: number }[];
  uncleared: { id: string; number: string; kind: string; method: string; amount: number; paymentDate: string }[];
  unclearedIn: number;
  /** Approved advances in the forecast's "out", and unspent cash due back in its "in". */
  advancesToRelease?: number;
  /** Approved budget requests (project cash) in the forecast's "out". */
  budgetRequestsToRelease?: number;
  refundsDue?: number;
  unclearedOut: number;
  netMovement: number;
}

export function CashFlow() {
  const [months, setMonths] = useState(6);
  const [data, setData] = useState<CashFlow | null>(null);
  const [error, setError] = useState<unknown>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setData(await api.get<CashFlow>(`/finance-reports/cash-flow${qs({ months })}`));
    } catch (err) {
      setError(err);
    }
  }, [months]);

  useEffect(() => {
    load();
  }, [load]);

  if (error) return <ErrorBox error={error} />;
  if (!data) return <Loading />;

  const peak = Math.max(1, ...data.months.map((m) => Math.max(m.in, m.out)));

  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <h1>Cash Flow</h1>
          <p>
            What has actually moved, and what is due to. Actuals count{' '}
            <strong>cleared money only</strong> — an uncleared cheque is a promise, and a position
            that counts promises is the one that bounces.
          </p>
        </div>
        <Field label="Months">
          <select value={months} onChange={(e) => setMonths(Number(e.target.value))}>
            <option value={3}>3</option>
            <option value={6}>6</option>
            <option value={12}>12</option>
          </select>
        </Field>
      </div>

      <div className="card">
        <h3 className="card-title">
          Cleared movement — net {formatMoney(data.netMovement)}
        </h3>
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>Month</th>
                <th className="right">In</th>
                <th className="right">Out</th>
                <th className="right">Net</th>
                <th className="fin-flow-col" />
              </tr>
            </thead>
            <tbody>
              {data.months.map((m) => (
                <tr key={m.month}>
                  <td className="mono">{m.month}</td>
                  <td className="right mono">{formatMoney(m.in)}</td>
                  <td className="right mono">{formatMoney(m.out)}</td>
                  <td className="right mono">
                    <span className={m.net < 0 ? 'warn' : ''}>{formatMoney(m.net)}</span>
                  </td>
                  <td>
                    {/* In above the line, out below — the shape tells the story
                        faster than the figures do. */}
                    <div className="flow-bars">
                      <div className="flow-in" style={{ width: `${(m.in / peak) * 50}%` }} />
                      <div className="flow-out" style={{ width: `${(m.out / peak) * 50}%` }} />
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="grid grid-2">
        <div className="card">
          <h3 className="card-title">What is due to move</h3>
          <p className="muted">
            Everything still owed, in and out, by when it falls due. Overdue is shown first because
            it is the part that has already gone wrong.
          </p>
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>When</th>
                  <th className="right">Coming in</th>
                  <th className="right">Going out</th>
                  <th className="right">Net</th>
                </tr>
              </thead>
              <tbody>
                {data.forecast.map((f) => (
                  <tr key={f.label}>
                    <td className={f.label === 'Overdue' ? 'warn' : ''}>{f.label}</td>
                    <td className="right mono">{formatMoney(f.in)}</td>
                    <td className="right mono">{formatMoney(f.out)}</td>
                    <td className="right mono">
                      <span className={f.net < 0 ? 'warn' : ''}>{formatMoney(f.net)}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {((data.advancesToRelease ?? 0) > 0 || (data.budgetRequestsToRelease ?? 0) > 0 || (data.refundsDue ?? 0) > 0) && (
            <p className="fin-note">
              Includes {formatMoney(data.advancesToRelease ?? 0)} of approved cash advances and{' '}
              {formatMoney(data.budgetRequestsToRelease ?? 0)} of approved budget requests going out, and{' '}
              {formatMoney(data.refundsDue ?? 0)} of unspent cash due back.
            </p>
          )}
        </div>

        <div className="card">
          <h3 className="card-title">Uncleared</h3>
          {data.uncleared.length === 0 ? (
            <p className="muted fin-flush">Nothing is waiting to clear.</p>
          ) : (
            <>
              <p className="muted">
                {formatMoney(data.unclearedIn)} in and {formatMoney(data.unclearedOut)} out, in
                neither the actuals nor the forecast until the bank says so.
              </p>
              <div className="table-wrap">
                <table className="data">
                  <tbody>
                    {data.uncleared.map((p) => (
                      <tr key={p.id}>
                        <td>
                          <Link to={`/g-fin/payments/${p.id}`} className="mono">
                            {p.number}
                          </Link>
                          <div className="faint">
                            {formatDate(p.paymentDate)} · {humanise(p.method)}
                          </div>
                        </td>
                        <td className="right mono">
                          <span className={p.kind === 'RECEIPT' ? '' : 'warn'}>
                            {p.kind === 'RECEIPT' ? '+' : '−'}
                            {formatMoney(p.amount)}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Budget vs actual ─────────────────────────────────────────────────────────

interface BudgetVsActual {
  jobs: {
    job: { id: string; number: string; name: string; status: string };
    customer: { id: string; name: string };
    contractValue: number;
    budgeted: number;
    committed: number;
    incurred: number;
    consumed: number;
    available: number;
    billed: number;
    invoiced: number;
    collected: number;
    uncollected: number;
    unbilled: number;
    expectedProfit: number;
    expectedMarginPct: number;
  }[];
  totals: Record<string, number> | null;
}

export function BudgetVsActual() {
  const [data, setData] = useState<BudgetVsActual | null>(null);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    api.get<BudgetVsActual>('/finance-reports/budget-vs-actual').then(setData).catch(setError);
  }, []);

  if (error) return <ErrorBox error={error} />;
  if (!data) return <Loading />;
  if (!data.jobs.length) return <Empty title="No projects yet" />;

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Budget vs Actual</h1>
          <p>
            Five columns that have to be read together. A project can be profitable on paper and
            still be the reason there is no cash — <strong>unbilled</strong> and{' '}
            <strong>uncollected</strong> are where that shows up.
          </p>
        </div>
      </div>

      <div className="card">
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>Project</th>
                <th className="right">Contract</th>
                <th className="right">Budgeted</th>
                <th className="right">Committed</th>
                <th className="right">Incurred</th>
                <th className="right">Available</th>
                <th className="right">Billed</th>
                <th className="right">Unbilled</th>
                <th className="right">Uncollected</th>
                <th className="right">Expected margin</th>
              </tr>
            </thead>
            <tbody>
              {data.jobs.map((r) => (
                <tr key={r.job.id}>
                  <td>
                    <Link to={`/g-ops/projects/${r.job.id}`} className="mono">
                      {r.job.number}
                    </Link>
                    <div className="faint">{r.customer?.name ?? r.job.name}</div>
                  </td>
                  <td className="right mono">{formatMoney(r.contractValue)}</td>
                  <td className="right mono">{formatMoney(r.budgeted)}</td>
                  <td className="right mono faint">{formatMoney(r.committed)}</td>
                  <td className="right mono">{formatMoney(r.incurred)}</td>
                  <td className="right mono">
                    <span className={r.available < 0 ? 'warn' : ''}>{formatMoney(r.available)}</span>
                  </td>
                  <td className="right mono">{formatMoney(r.billed)}</td>
                  <td className="right mono">
                    <span className={r.unbilled > 0 ? 'warn' : 'faint'}>{formatMoney(r.unbilled)}</span>
                  </td>
                  <td className="right mono">
                    <span className={r.uncollected > 0 ? 'warn' : 'faint'}>
                      {formatMoney(r.uncollected)}
                    </span>
                  </td>
                  <td className="right mono">{r.expectedMarginPct.toFixed(1)}%</td>
                </tr>
              ))}
            </tbody>
            {data.totals && (
              <tfoot>
                <tr>
                  <th>Total</th>
                  <th className="right mono">{formatMoney(data.totals.contractValue)}</th>
                  <th className="right mono">{formatMoney(data.totals.budgeted)}</th>
                  <th className="right mono">{formatMoney(data.totals.committed)}</th>
                  <th className="right mono">{formatMoney(data.totals.incurred)}</th>
                  <th className="right mono">{formatMoney(data.totals.available)}</th>
                  <th className="right mono">{formatMoney(data.totals.billed)}</th>
                  <th className="right mono">{formatMoney(data.totals.unbilled)}</th>
                  <th className="right mono">{formatMoney(data.totals.uncollected)}</th>
                  <th />
                </tr>
              </tfoot>
            )}
          </table>
        </div>
        <p className="faint fin-gap-top fin-flush">
          Available is budgeted less committed less incurred. Consumed — stock issued to the job —
          is reported on the project screen but never subtracted here, because it was already
          counted as incurred when the goods were received.
        </p>
      </div>
    </div>
  );
}

// ── Settings ─────────────────────────────────────────────────────────────────

interface FinSettings {
  defaultTermsDays: number;
  supplierEwtGoods: number;
  supplierEwtServices: number;
  agingBuckets: number[];
  advanceLiquidationDays: number;
  blockAdvanceWhileUnliquidated: boolean;
  budgetRequestLiquidationDays: number;
  vatRate: number;
  ewtRate: number;
}

export function FinanceSettings() {
  const { can } = useAuth();
  const toast = useToast();
  const editable = can('gfin.settings.edit_all');
  const [settings, setSettings] = useState<FinSettings | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.get<FinSettings>('/finance-settings').then(setSettings).catch(setError);
  }, []);

  // A refused save keeps the form on screen, with the reason under the head.
  if (error && !settings) return <ErrorBox error={error} />;
  if (!settings) return <Loading />;

  async function save() {
    if (!settings) return;
    setBusy(true);
    setError(null);
    try {
      const saved = await api.put<FinSettings>('/finance-settings', {
        defaultTermsDays: settings.defaultTermsDays,
        supplierEwtGoods: settings.supplierEwtGoods,
        supplierEwtServices: settings.supplierEwtServices,
        agingBuckets: settings.agingBuckets,
        advanceLiquidationDays: settings.advanceLiquidationDays,
        blockAdvanceWhileUnliquidated: settings.blockAdvanceWhileUnliquidated,
        budgetRequestLiquidationDays: settings.budgetRequestLiquidationDays,
      });
      setSettings({ ...settings, ...saved });
      toast('ok', 'Finance rules saved');
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  const set = <K extends keyof FinSettings>(key: K, value: FinSettings[K]) =>
    setSettings({ ...settings, [key]: value });

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Finance Settings</h1>
          <p>
            Payment terms, what Gruntech withholds from its own suppliers, how the aging report is
            bucketed, and the rules for cash advances and budget requests.
          </p>
        </div>
        {editable && (
          <button className="btn btn-primary" onClick={save} disabled={busy}>
            {busy ? 'Saving…' : 'Save'}
          </button>
        )}
      </div>

      <ErrorBox error={error} />

      <fieldset disabled={!editable} className="fin-fieldset">
        <div className="grid grid-2">
          <div className="card">
            <h3 className="card-title">Terms</h3>
            <Field
              label="Default payment terms (days)"
              hint="Used when nothing else is said — on invoices we raise and bills we enter"
            >
              <NumberInput
                kind="count"
                min={0}
                max={365}
                value={settings.defaultTermsDays}
                onChange={(e) => set('defaultTermsDays', Number(e.target.value))}
              />
            </Field>
            <Field label="Aging buckets (days)" hint="In increasing order. The last one is open-ended.">
              <input
                value={settings.agingBuckets.join(', ')}
                onChange={(e) =>
                  set(
                    'agingBuckets',
                    e.target.value
                      .split(',')
                      .map((s) => Number(s.trim()))
                      .filter((n) => Number.isFinite(n) && n > 0),
                  )
                }
              />
            </Field>
          </div>

          <div className="card">
            <h3 className="card-title">What we withhold from suppliers</h3>
            <p className="muted">
              Suggestions offered on the bill screen, not an automatic deduction. Withholding when
              you should not have underpays a supplier and is awkward to unwind.
            </p>
            <Field label="Goods (%)">
              <NumberInput
                kind="percent"
                step="0.001"
                min={0}
                max={1}
                value={settings.supplierEwtGoods}
                onChange={(e) => set('supplierEwtGoods', Number(e.target.value))}
              />
            </Field>
            <Field label="Services / subcontract (%)">
              <NumberInput
                kind="percent"
                step="0.001"
                min={0}
                max={1}
                value={settings.supplierEwtServices}
                onChange={(e) => set('supplierEwtServices', Number(e.target.value))}
              />
            </Field>
          </div>

          <div className="card">
            <h3 className="card-title">What customers withhold from us</h3>
            <dl className="kv">
              <dt>Output VAT</dt>
              <dd className="mono">{(settings.vatRate * 100).toFixed(0)}%</dd>
              <dt>EWT withheld</dt>
              <dd className="mono">{(settings.ewtRate * 100).toFixed(0)}%</dd>
            </dl>
            <div className="alert info fin-gap-top fin-flush">
              These live on the company record, because they are printed on every quotation,
              billing and invoice. Change them in Admin › Company. Each document snapshots the
              rate it was issued under, so changing them never rewrites history.
            </div>
          </div>

          <div className="card">
            <h3 className="card-title">Cash advances</h3>
            <Field
              label="Days to liquidate"
              hint="Counted from the day the cash is handed over. Set on each advance when it is released, so changing this never moves a deadline already given."
            >
              <NumberInput
                kind="count"
                min={1}
                max={365}
                value={settings.advanceLiquidationDays}
                onChange={(e) => set('advanceLiquidationDays', Number(e.target.value))}
              />
            </Field>
            <Field
              label="One advance at a time"
              hint="Refuse a new advance to somebody who has not liquidated the last one. Turn off if staff often run two trips at once."
            >
              <select
                value={settings.blockAdvanceWhileUnliquidated ? 'yes' : 'no'}
                onChange={(e) => set('blockAdvanceWhileUnliquidated', e.target.value === 'yes')}
              >
                <option value="yes">Yes — liquidate first</option>
                <option value="no">No — allow several</option>
              </select>
            </Field>
          </div>

          <div className="card">
            <h3 className="card-title">Budget requests</h3>
            <Field
              label="Days to liquidate"
              hint="Project cash, its own rule — a budget request is the project's money, not a personal loan. Counted from the day the cash is released and set on each request then, so changing this never moves a deadline already given."
            >
              <NumberInput
                kind="count"
                min={1}
                max={365}
                value={settings.budgetRequestLiquidationDays}
                onChange={(e) => set('budgetRequestLiquidationDays', Number(e.target.value))}
              />
            </Field>
          </div>
        </div>
      </fieldset>

      {/* Again at the foot: the form is longer than a screen — and so is
          the reason a save was refused, said here too beside the button
          that was pressed. */}
      {editable && (
        <div className="fin-gap-top">
          <ErrorBox error={error} />
          <div className="right">
            <button className="btn btn-primary" onClick={save} disabled={busy}>
              {busy ? 'Saving…' : 'Save'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
