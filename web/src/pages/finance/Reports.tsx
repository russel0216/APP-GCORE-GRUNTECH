import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, qs } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { Empty, ErrorBox, Field, Loading, formatDate, formatMoney, useToast } from '../../components/ui';
import { BarList, Donut, Meter, Panel, Stat, type Slice } from '../../components/charts';
import { IconBadge } from '../../components/Icon';

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

interface AgingBucket {
  label: string;
  amount: number;
  count: number;
}

interface AgedRow {
  id: string;
  number: string;
  party: string;
  partyId: string;
  date: string;
  dueDate: string;
  daysOverdue: number;
  payable: number;
  paid: number;
  outstanding: number;
  bucket: string;
  jobNumber: string | null;
  withheld?: number;
}

interface ArAging {
  asOf: string;
  buckets: AgingBucket[];
  rows: AgedRow[];
  customers: { id: string; name: string; outstanding: number; overdue: number; invoices: number }[];
  totalOutstanding: number;
  totalOverdue: number;
  withheldAwaitingCertificate: number;
}

interface ApAging {
  asOf: string;
  buckets: AgingBucket[];
  rows: AgedRow[];
  suppliers: { id: string; name: string; outstanding: number; overdue: number; bills: number }[];
  totalOutstanding: number;
  totalOverdue: number;
  unreimbursedClaims: { id: string; number: string; person: string; claimDate: string; outstanding: number }[];
  unreimbursedTotal: number;
}

// ── Executive dashboard ──────────────────────────────────────────────────────

interface Dashboard {
  asOf: string;
  receivable: number;
  receivableOverdue: number;
  payable: number;
  payableOverdue: number;
  reimbursable: number;
  workingPosition: number;
  collectedThisMonth: number;
  collectedThisYear: number;
  invoicedThisYear: number;
  withheldAwaitingCertificate: number;
  queue: { billingsAwaitingInvoice: number; receivingsAwaitingBill: number };
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
      sub: 'receivable less everything owed',
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
    <div>
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

// ── Aging ────────────────────────────────────────────────────────────────────

export function FinanceReports() {
  const { can } = useAuth();
  const [tab, setTab] = useState<'ar' | 'ap'>(can('gfin.ar.view_all') ? 'ar' : 'ap');

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Finance Reports</h1>
          <p>
            Who owes us and who we owe, by how late it is. A balance that is not yet due sits in
            Current — being invoiced is not the same as being overdue.
          </p>
        </div>
      </div>

      <div className="scope-switch" style={{ marginBottom: 16 }}>
        {can('gfin.ar.view_all') && (
          <button className={tab === 'ar' ? 'active' : ''} onClick={() => setTab('ar')}>
            Receivables aging
          </button>
        )}
        {can('gfin.ap.view_all') && (
          <button className={tab === 'ap' ? 'active' : ''} onClick={() => setTab('ap')}>
            Payables aging
          </button>
        )}
      </div>

      {tab === 'ar' ? <ArAgingReport /> : <ApAgingReport />}
    </div>
  );
}

function BucketStrip({ buckets, total }: { buckets: AgingBucket[]; total: number }) {
  return (
    <div className="grid grid-4" style={{ marginBottom: 18 }}>
      {buckets.map((b) => (
        <div key={b.label} className="card">
          <div className="faint" style={{ fontSize: 11, letterSpacing: 1 }}>
            {b.label === 'Current' ? 'NOT YET DUE' : `${b.label} DAYS LATE`}
          </div>
          <div
            style={{
              fontSize: 20,
              marginTop: 6,
              fontWeight: 600,
              color: b.label === 'Current' ? undefined : b.amount > 0 ? 'var(--warn)' : undefined,
            }}
          >
            {formatMoney(b.amount)}
          </div>
          <div className="faint" style={{ fontSize: 11, marginTop: 4 }}>
            {b.count} document{b.count === 1 ? '' : 's'}
            {total > 0 && ` · ${((b.amount / total) * 100).toFixed(0)}%`}
          </div>
        </div>
      ))}
    </div>
  );
}

function ArAgingReport() {
  const [data, setData] = useState<ArAging | null>(null);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    api.get<ArAging>('/finance-reports/ar-aging').then(setData).catch(setError);
  }, []);

  if (error) return <ErrorBox error={error} />;
  if (!data) return <Loading />;
  if (!data.rows.length) return <Empty title="Nothing outstanding" hint="Every issued invoice has been collected." />;

  return (
    <div>
      <BucketStrip buckets={data.buckets} total={data.totalOutstanding} />

      {data.withheldAwaitingCertificate > 0 && (
        <div className="alert info">
          {formatMoney(data.withheldAwaitingCertificate)} of EWT has been withheld on these
          invoices with no BIR 2307 recorded yet. It is <strong>not</strong> part of the
          {' '}{formatMoney(data.totalOutstanding)} outstanding — it comes back as a tax credit, not
          as cash — but it is worth chasing.
        </div>
      )}

      <div className="card">
        <h3 className="card-title">
          {formatMoney(data.totalOutstanding)} outstanding · {formatMoney(data.totalOverdue)} overdue
        </h3>
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>Customer</th>
                <th className="right">Invoices</th>
                <th className="right">Outstanding</th>
                <th className="right">Overdue</th>
              </tr>
            </thead>
            <tbody>
              {data.customers.map((c) => (
                <tr key={c.id}>
                  <td>
                    <Link to={`/g-ops/customers/${c.id}`}>{c.name}</Link>
                  </td>
                  <td className="right mono">{c.invoices}</td>
                  <td className="right mono">{formatMoney(c.outstanding)}</td>
                  <td className="right mono">
                    {c.overdue > 0 ? <span className="warn">{formatMoney(c.overdue)}</span> : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="card">
        <h3 className="card-title">Every open invoice</h3>
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>Invoice</th>
                <th>Customer</th>
                <th>Due</th>
                <th className="right">Collectible</th>
                <th className="right">Collected</th>
                <th className="right">Outstanding</th>
                <th>Age</th>
              </tr>
            </thead>
            <tbody>
              {data.rows.map((r) => (
                <tr key={r.id}>
                  <td>
                    <Link to={`/g-fin/ar/${r.id}`} className="mono">
                      {r.number}
                    </Link>
                    {r.jobNumber && <div className="faint mono">{r.jobNumber}</div>}
                  </td>
                  <td>{r.party}</td>
                  <td className="faint">{formatDate(r.dueDate)}</td>
                  <td className="right mono">{formatMoney(r.payable)}</td>
                  <td className="right mono faint">{formatMoney(r.paid)}</td>
                  <td className="right mono">{formatMoney(r.outstanding)}</td>
                  <td>
                    <span className={`badge ${r.bucket === 'Current' ? '' : 'warn'}`}>{r.bucket}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function ApAgingReport() {
  const [data, setData] = useState<ApAging | null>(null);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    api.get<ApAging>('/finance-reports/ap-aging').then(setData).catch(setError);
  }, []);

  if (error) return <ErrorBox error={error} />;
  if (!data) return <Loading />;

  return (
    <div>
      <BucketStrip buckets={data.buckets} total={data.totalOutstanding} />

      <div className="card">
        <h3 className="card-title">
          {formatMoney(data.totalOutstanding)} payable · {formatMoney(data.totalOverdue)} overdue
        </h3>
        {data.suppliers.length === 0 ? (
          <p className="muted" style={{ marginBottom: 0 }}>
            Nothing outstanding to suppliers.
          </p>
        ) : (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Supplier</th>
                  <th className="right">Bills</th>
                  <th className="right">Outstanding</th>
                  <th className="right">Overdue</th>
                </tr>
              </thead>
              <tbody>
                {data.suppliers.map((s) => (
                  <tr key={s.id}>
                    <td>
                      <Link to={`/g-chain/suppliers/${s.id}`}>{s.name}</Link>
                    </td>
                    <td className="right mono">{s.bills}</td>
                    <td className="right mono">{formatMoney(s.outstanding)}</td>
                    <td className="right mono">
                      {s.overdue > 0 ? <span className="warn">{formatMoney(s.overdue)}</span> : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {data.unreimbursedClaims.length > 0 && (
        <div className="card">
          <h3 className="card-title">
            {formatMoney(data.unreimbursedTotal)} owed back to staff
          </h3>
          <p className="muted">
            Approved expense claims nobody has been paid for yet. People spent their own money.
          </p>
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Claim</th>
                  <th>Who</th>
                  <th>Dated</th>
                  <th className="right">Owed</th>
                </tr>
              </thead>
              <tbody>
                {data.unreimbursedClaims.map((c) => (
                  <tr key={c.id}>
                    <td>
                      <Link to={`/g-fin/expenses/${c.id}`} className="mono">
                        {c.number}
                      </Link>
                    </td>
                    <td>{c.person}</td>
                    <td className="faint">{formatDate(c.claimDate)}</td>
                    <td className="right mono">{formatMoney(c.outstanding)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {data.rows.length > 0 && (
        <div className="card">
          <h3 className="card-title">Every open bill</h3>
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Bill</th>
                  <th>Supplier</th>
                  <th>Due</th>
                  <th className="right">Payable</th>
                  <th className="right">Paid</th>
                  <th className="right">Outstanding</th>
                  <th>Age</th>
                </tr>
              </thead>
              <tbody>
                {data.rows.map((r) => (
                  <tr key={r.id}>
                    <td>
                      <Link to={`/g-fin/ap/${r.id}`} className="mono">
                        {r.number}
                      </Link>
                      {r.jobNumber && <div className="faint mono">{r.jobNumber}</div>}
                    </td>
                    <td>{r.party}</td>
                    <td className="faint">{formatDate(r.dueDate)}</td>
                    <td className="right mono">{formatMoney(r.payable)}</td>
                    <td className="right mono faint">{formatMoney(r.paid)}</td>
                    <td className="right mono">{formatMoney(r.outstanding)}</td>
                    <td>
                      <span className={`badge ${r.bucket === 'Current' ? '' : 'warn'}`}>{r.bucket}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Cash flow ────────────────────────────────────────────────────────────────

interface CashFlow {
  months: { month: string; in: number; out: number; net: number }[];
  forecast: { label: string; in: number; out: number; net: number }[];
  uncleared: { number: string; kind: string; method: string; amount: number; paymentDate: string }[];
  unclearedIn: number;
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
    <div>
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
                <th style={{ width: '34%' }} />
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
        </div>

        <div className="card">
          <h3 className="card-title">Uncleared</h3>
          {data.uncleared.length === 0 ? (
            <p className="muted" style={{ marginBottom: 0 }}>
              Nothing is waiting to clear.
            </p>
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
                      <tr key={p.number}>
                        <td>
                          <span className="mono">{p.number}</span>
                          <div className="faint">
                            {formatDate(p.paymentDate)} · {p.method.toLowerCase().replace(/_/g, ' ')}
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
        <p className="faint" style={{ marginTop: 12, marginBottom: 0 }}>
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

  if (error) return <ErrorBox error={error} />;
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
            Payment terms, what Gruntech withholds from its own suppliers, and how the aging
            report is bucketed.
          </p>
        </div>
        {editable && (
          <button className="btn btn-primary btn-sm" onClick={save} disabled={busy}>
            {busy ? 'Saving…' : 'Save rules'}
          </button>
        )}
      </div>

      <fieldset disabled={!editable} style={{ border: 0, padding: 0, margin: 0 }}>
        <div className="grid grid-2">
          <div className="card">
            <h3 className="card-title">Terms</h3>
            <Field
              label="Default payment terms (days)"
              hint="Used when nothing else is said — on invoices we raise and bills we enter"
            >
              <input
                type="number"
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
              <input
                type="number"
                step="0.001"
                min={0}
                max={1}
                value={settings.supplierEwtGoods}
                onChange={(e) => set('supplierEwtGoods', Number(e.target.value))}
              />
            </Field>
            <Field label="Services / subcontract (%)">
              <input
                type="number"
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
            <div className="alert info" style={{ marginTop: 12, marginBottom: 0 }}>
              These live on the company record, because they are printed on every quotation,
              billing and invoice. Change them in Admin › Company. Each document snapshots the
              rate it was issued under, so changing them never rewrites history.
            </div>
          </div>
        </div>
      </fieldset>
    </div>
  );
}
