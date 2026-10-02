import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, qs, getToken } from '../../lib/api';
import { ErrorBox, Field, Loading, formatMoney, useToast } from '../../components/ui';
import {
  Brief,
  MiniBar as Bar,
  Panel,
  Stat as Tile,
  type BriefLine,
  type BriefPart,
  type Tone,
} from '../../components/charts';
import { firstOfMonth, monthOf, todayLocal } from '../../lib/day';
import { useAuth } from '../../lib/auth';

/**
 * Insights — the reporting layer (Phase 9).
 *
 * Every figure on these screens is read off documents the other eight phases
 * record. Nothing here keeps its own copy of a number, which is the only way a
 * management report can never disagree with the records behind it — and why
 * each figure links to the list it came from rather than ending the trail.
 */

// ── Shared bits ──────────────────────────────────────────────────────────────

/**
 * The Insights metric card, under the name its 32 call sites already use.
 *
 * The body moved to components/charts.tsx. This one was a `<div>` with an
 * onClick, so every one of those 32 cards was unreachable by keyboard and
 * announced as nothing in particular; the shared card is a `<Link>`.
 */
export { Tile };

/** The date range every report shares, so one habit works everywhere. */
export function RangePicker({
  from,
  to,
  onChange,
}: {
  from: string;
  to: string;
  onChange: (from: string, to: string) => void;
}) {
  const today = todayLocal();
  const monthStart = firstOfMonth(monthOf(today));
  const yearStart = `${today.slice(0, 4)}-01-01`;
  return (
    <div className="row">
      <Field label="From">
        <input type="date" value={from} onChange={(e) => onChange(e.target.value, to)} />
      </Field>
      <Field label="To">
        <input type="date" value={to} onChange={(e) => onChange(from, e.target.value)} />
      </Field>
      <button
        className={`btn btn-sm${from === monthStart && to === today ? ' btn-active' : ''}`}
        onClick={() => onChange(monthStart, today)}
      >
        This month
      </button>
      <button
        className={`btn btn-sm${from === yearStart && to === today ? ' btn-active' : ''}`}
        onClick={() => onChange(yearStart, today)}
      >
        This year
      </button>
    </div>
  );
}

/** Downloads a report's CSV twin, with the token the API expects. */
export function ExportButton({ path, label = 'Export CSV' }: { path: string; label?: string }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);

  async function run() {
    setBusy(true);
    try {
      const res = await fetch(`/api${path}`, { headers: { Authorization: `Bearer ${getToken()}` } });
      if (!res.ok) throw new Error('The export was refused');
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${path.split('/').pop()?.split('?')[0] ?? 'export.csv'}`;
      a.click();
      URL.revokeObjectURL(url);
      toast('ok', 'Downloaded');
    } catch {
      toast('error', 'That export is not available to you');
    } finally {
      setBusy(false);
    }
  }

  return (
    <button className="btn btn-sm" onClick={run} disabled={busy}>
      {busy ? 'Building…' : label}
    </button>
  );
}

/** A bar whose width is a share of the largest value in its group. */
/** The in-cell bar, under the name the Insights screens already import. */
export { Bar };

// ── Company overview ─────────────────────────────────────────────────────────

type SummaryModule = 'gops' | 'gchain' | 'ghr' | 'gfin';

interface SummaryFigure {
  key: string;
  label: string;
  value: number;
  kind: 'count' | 'money' | 'hours';
  basis: 'live' | 'range';
  scope?: 'all' | 'mine';
  to: string;
}

interface SummaryLine {
  module: SummaryModule;
  label: string;
  to: string;
  asOf?: string;
  day?: string;
  figures: SummaryFigure[];
}

interface Summary {
  range: { from: string; to: string };
  asOf: string;
  lines: Record<SummaryModule, SummaryLine | null>;
}

interface Dashboard {
  range: { from: string; to: string };
  sales: {
    openQuotations: number;
    openPipeline: number;
    weightedPipeline: number;
    won: number;
    lost: number;
    winRatePct: number;
  };
  delivery: {
    activeJobs: number;
    jobsDelivered: number;
    budgeted: number;
    committed: number;
    incurred: number;
    available: number;
    billedInRange: number;
  };
  finance: {
    receivable: number;
    receivableOverdue: number;
    payable: number;
    payableOverdue: number;
    reimbursable: number;
    advancesToRelease: number;
    collectedThisMonth: number;
    collectedInRange: number;
    workingPosition: number;
  };
  chain: { stockValue: number; stockLines: number };
  aftermarket: { contractsActive: number; visitsOverdue: number };
  people: { headcount: number; pendingApprovals: number };
  summary: Summary;
}

interface Trend {
  months: { month: string; billed: number; collected: number; incurred: number; won: number }[];
}

/**
 * One clause of a brief sentence: an optional lead-in, the figure, and what
 * it counts. A clause whose figure the server withheld is dropped whole — the
 * sentence still reads, it just says less.
 */
interface Clause {
  key: string;
  pre?: string;
  one?: string;
  many?: string;
}

/** Each line is groups of clauses: ", " inside a group, " · " between groups. */
const SENTENCES: Record<SummaryModule, Clause[][]> = {
  gops: [
    [
      { key: 'enquiriesInPlay', one: 'enquiry in play', many: 'enquiries in play' },
      { key: 'quotationsOut', one: 'quotation out', many: 'quotations out' },
      { key: 'quotationsNegotiating', one: 'in negotiation' },
    ],
    [
      { key: 'projectsInProgress', one: 'project in progress', many: 'projects in progress' },
      { key: 'projectsOnHold', one: 'on hold' },
      {
        key: 'reportsAwaitingApproval',
        one: 'progress report awaiting approval',
        many: 'progress reports awaiting approval',
      },
    ],
    [
      { key: 'contractsRunning', one: 'service contract running', many: 'service contracts running' },
      { key: 'pmAccomplished', one: 'PM visit done in range', many: 'PM visits done in range' },
    ],
  ],
  gchain: [
    [
      {
        key: 'requestsAwaitingApproval',
        one: 'purchase request awaiting approval',
        many: 'purchase requests awaiting approval',
      },
      { key: 'ordersAwaitingDelivery', one: 'order awaiting delivery', many: 'orders awaiting delivery' },
      { key: 'borrowSlipsOverdue', one: 'borrow slip overdue', many: 'borrow slips overdue' },
    ],
    [{ key: 'stockValue', one: 'of stock on hand' }],
  ],
  ghr: [
    [{ key: 'headcount', one: 'active employee', many: 'active employees' }],
    [
      { key: 'present', pre: 'today ', one: 'present' },
      { key: 'late', one: 'late' },
      { key: 'onLeave', one: 'on leave' },
      { key: 'absent', one: 'absent' },
    ],
    [{ key: 'pendingApprovals', one: 'HR approval waiting', many: 'HR approvals waiting' }],
    [
      { key: 'overtimeHours', one: 'h of overtime approved in range' },
      { key: 'overtimeAmount', one: 'charged to projects' },
    ],
  ],
  gfin: [
    [
      { key: 'receivable', pre: 'customers owe ' },
      { key: 'receivableOverdue', one: 'of it overdue' },
    ],
    [
      { key: 'payable', pre: 'we owe suppliers ' },
      { key: 'payableOverdue', one: 'of it overdue' },
    ],
    [
      { key: 'reimbursable', pre: 'staff are owed ' },
      { key: 'advancesToRelease', one: 'in approved advances not yet released' },
    ],
    [{ key: 'workingPosition', pre: 'working position ' }],
    [
      { key: 'collectedInRange', one: 'collected in range' },
      {
        key: 'billingsAwaitingInvoice',
        one: 'approved billing not yet invoiced',
        many: 'approved billings not yet invoiced',
      },
    ],
  ],
};

/**
 * Colour only ADDS to the words, and only when a figure needs a look — a
 * zero is never painted. Every toned figure already says what it is.
 */
function toneFor(key: string, value: number): Tone | undefined {
  if (key === 'workingPosition') return value < 0 ? 'danger' : undefined;
  if (value <= 0) return undefined;
  if (['payableOverdue', 'absent', 'borrowSlipsOverdue'].includes(key)) return 'danger';
  if (
    ['receivableOverdue', 'late', 'pendingApprovals', 'reportsAwaitingApproval', 'requestsAwaitingApproval'].includes(
      key,
    )
  ) {
    return 'warn';
  }
  return undefined;
}

function show(f: SummaryFigure): string {
  if (f.kind === 'money') return formatMoney(f.value);
  // Hours to two decimals everywhere, the CSV included.
  if (f.kind === 'hours') return f.value.toFixed(2);
  return String(f.value);
}

function clockOf(iso: string | undefined): string {
  if (!iso) return '';
  return new Date(iso).toLocaleTimeString('en-PH', { hour: 'numeric', minute: '2-digit' });
}

/** Four sentences from the server's figures — numbers, labels and paths only. */
export function composeLines(summary: Summary): BriefLine[] {
  const out: BriefLine[] = [];
  for (const module of ['gops', 'gchain', 'ghr', 'gfin'] as SummaryModule[]) {
    const line = summary.lines[module];
    if (!line) continue;
    const byKey = new Map(line.figures.map((f) => [f.key, f]));

    const groups: BriefPart[][] = [];
    for (const group of SENTENCES[module]) {
      const clauses: BriefPart[][] = [];
      for (const c of group) {
        const f = byKey.get(c.key);
        if (!f) continue;
        const noun = f.value === 1 || !c.many ? c.one : c.many;
        const parts: BriefPart[] = [];
        if (c.pre) parts.push({ text: c.pre });
        parts.push({
          value: show(f),
          to: f.to,
          tone: toneFor(f.key, f.value),
          label: f.scope === 'mine' ? `${f.label} (yours)` : f.label,
        });
        if (noun) parts.push({ text: ` ${noun}` });
        if (f.scope === 'mine') parts.push({ text: ' (yours)' });
        clauses.push(parts);
      }
      if (clauses.length) {
        groups.push(clauses.flatMap((parts, i) => (i === 0 ? parts : [{ text: ', ' }, ...parts])));
      }
    }
    if (!groups.length) continue;

    const parts = groups.flatMap((g, i) => (i === 0 ? g : [{ text: ' · ' }, ...g]));
    // Sentence case: the first word is capitalised wherever it landed.
    const first = parts[0];
    if (first.text) parts[0] = { ...first, text: first.text.charAt(0).toUpperCase() + first.text.slice(1) };
    parts.push({ text: '.' });

    const mine = line.figures.some((f) => f.scope === 'mine');
    const hint =
      module === 'ghr'
        ? `Attendance as of ${clockOf(line.asOf)} on HR's day (${line.day}). Absence is inferred, and corrects itself when someone clocks in.`
        : mine
          ? 'Figures marked "yours" count your own records only — you can see no one else\'s.'
          : undefined;

    out.push({ key: module, tag: line.label, to: line.to, hint, parts });
  }
  return out;
}

export function CompanyOverview() {
  const { can } = useAuth();
  const thisYear = new Date().getFullYear();
  const [from, setFrom] = useState(`${thisYear}-01-01`);
  const [to, setTo] = useState(todayLocal());
  const [data, setData] = useState<Dashboard | null>(null);
  const [trend, setTrend] = useState<Trend | null>(null);
  const [error, setError] = useState<unknown>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      // The brief rides on the dashboard response: one read, one snapshot.
      const [d, t] = await Promise.all([
        api.get<Dashboard>(`/insights/dashboard${qs({ from, to })}`),
        api.get<Trend>('/insights/trend?months=12'),
      ]);
      setData(d);
      setTrend(t);
    } catch (err) {
      setError(err);
    }
  }, [from, to]);

  useEffect(() => {
    load();
  }, [load]);

  if (error) return <ErrorBox error={error} />;
  if (!data || !trend) return <Loading label="Reading the books…" />;

  const peak = Math.max(
    1,
    ...trend.months.flatMap((m) => [m.billed, m.collected, m.incurred, m.won]),
  );

  const briefLines = data.summary ? composeLines(data.summary) : [];

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Company Overview</h1>
          <p>
            Every figure here is read off the documents themselves — no report keeps its own copy
            of a number, so nothing on this page can disagree with the records behind it. Click any
            of them to see what they are made of.
          </p>
        </div>
        <RangePicker
          from={from}
          to={to}
          onChange={(f, t) => {
            setFrom(f);
            setTo(t);
          }}
        />
      </div>

      {briefLines.length > 0 && (
        <div style={{ marginBottom: 'var(--s-5)' }}>
          <Panel
            title="The company at a glance"
            blurb="One line per division, each read through that division's own dashboard — where they differ, this page is wrong. Every figure opens the list it counts; a line you cannot see is a dashboard you cannot open."
            action={
              can('insights.dashboard.export') ? (
                <ExportButton path={`/insights/summary.csv${qs({ from, to })}`} label="Export summary" />
              ) : undefined
            }
          >
            <Brief
              lines={briefLines}
              caption={`Queues and balances are live, as of ${clockOf(data.summary.asOf)}. Figures marked "in range" follow the dates above (${from} → ${to}), counted on Manila's calendar days.`}
            />
          </Panel>
        </div>
      )}

      <h3 className="section-label">Winning work</h3>
      <div className="grid grid-4" style={{ marginBottom: 'var(--s-5)' }}>
        <Tile
          label="Open pipeline"
          value={formatMoney(data.sales.openPipeline)}
          sub={`${data.sales.openQuotations} quotation${data.sales.openQuotations === 1 ? '' : 's'} out`}
          to="/g-ops/quotations"
        />
        <Tile
          label="Weighted"
          value={formatMoney(data.sales.weightedPipeline)}
          sub="at the salespeople's own odds"
          tone="var(--neon)"
          to="/insights/pipeline"
        />
        <Tile
          label="Win rate"
          value={`${data.sales.winRatePct.toFixed(0)}%`}
          sub={`${data.sales.won} won, ${data.sales.lost} lost in range`}
          to="/insights/pipeline"
        />
        <Tile
          label="Billed in range"
          value={formatMoney(data.delivery.billedInRange)}
          sub="approved progress billings"
          to="/g-ops/progress"
        />
      </div>

      <h3 className="section-label">Delivering it</h3>
      <div className="grid grid-4" style={{ marginBottom: 'var(--s-5)' }}>
        <Tile
          label="Active projects"
          value={data.delivery.activeJobs}
          sub={`planning or in progress, every job type · ${data.delivery.jobsDelivered} delivered in range`}
          to="/g-ops/projects"
        />
        <Tile
          label="Budgeted"
          value={formatMoney(data.delivery.budgeted)}
          sub="across every live job"
          to="/insights/profitability"
        />
        <Tile
          label="Committed + incurred"
          value={formatMoney(data.delivery.committed + data.delivery.incurred)}
          sub="spent or promised"
          to="/g-ops/budget-monitoring"
        />
        <Tile
          label="Available"
          value={formatMoney(data.delivery.available)}
          sub="budgeted less committed less incurred"
          tone={data.delivery.available < 0 ? 'var(--danger)' : undefined}
          to="/g-ops/budget-monitoring"
        />
      </div>

      <h3 className="section-label">Getting paid</h3>
      <div className="grid grid-4" style={{ marginBottom: 'var(--s-5)' }}>
        <Tile
          label="Receivable"
          value={formatMoney(data.finance.receivable)}
          sub={
            data.finance.receivableOverdue > 0
              ? `${formatMoney(data.finance.receivableOverdue)} overdue`
              : 'nothing overdue'
          }
          tone={data.finance.receivableOverdue > 0 ? 'var(--warn)' : 'var(--neon)'}
          to="/g-fin/ar?outstanding=true"
        />
        <Tile
          label="Payable"
          value={formatMoney(data.finance.payable)}
          sub={
            data.finance.payableOverdue > 0
              ? `${formatMoney(data.finance.payableOverdue)} overdue`
              : 'supplier bills outstanding'
          }
          tone={data.finance.payableOverdue > 0 ? 'var(--danger)' : undefined}
          to="/g-fin/ap?outstanding=true"
        />
        <Tile
          label="Collected this month"
          value={formatMoney(data.finance.collectedThisMonth)}
          sub={`${formatMoney(data.finance.collectedInRange)} in range`}
          to="/g-fin/payments"
        />
        <Tile
          label="Working position"
          value={formatMoney(data.finance.workingPosition)}
          sub="receivable less everything owed"
          tone={data.finance.workingPosition < 0 ? 'var(--danger)' : undefined}
          to="/insights/cash-forecast"
        />
      </div>

      <h3 className="section-label">Everything else</h3>
      <div className="grid grid-4" style={{ marginBottom: 'var(--s-5)' }}>
        <Tile
          label="Stock value"
          value={formatMoney(data.chain.stockValue)}
          sub={`${data.chain.stockLines} item lines`}
          to="/insights/inventory"
        />
        <Tile
          label="Service contracts"
          value={data.aftermarket.contractsActive}
          sub={
            data.aftermarket.visitsOverdue > 0
              ? `${data.aftermarket.visitsOverdue} visits overdue`
              : 'visits on schedule'
          }
          tone={data.aftermarket.visitsOverdue > 0 ? 'var(--warn)' : undefined}
          to="/g-ops/service-contracts?status=ACTIVE"
        />
        <Tile label="Headcount" value={data.people.headcount} sub="active employees" to="/g-hr" />
        <Tile
          label="Waiting on an approval"
          value={data.people.pendingApprovals}
          sub="across every document type"
          tone={data.people.pendingApprovals > 0 ? 'var(--warn)' : undefined}
          to="/insights/performance"
        />
      </div>

      <div className="card">
        <h3 className="card-title">Twelve months</h3>
        <p className="muted">
          Billed against collected is the one worth watching: the gap between them is the working
          capital the company is lending its customers.
        </p>
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>Month</th>
                <th className="right">Won</th>
                <th className="right">Billed</th>
                <th className="right">Collected</th>
                <th className="right">Cost incurred</th>
                <th style={{ width: '28%' }}>Billed vs collected</th>
              </tr>
            </thead>
            <tbody>
              {trend.months.map((m) => (
                <tr key={m.month}>
                  <td className="mono">{m.month}</td>
                  <td className="right mono faint">{m.won ? formatMoney(m.won) : '—'}</td>
                  <td className="right mono">{m.billed ? formatMoney(m.billed) : '—'}</td>
                  <td className="right mono">{m.collected ? formatMoney(m.collected) : '—'}</td>
                  <td className="right mono faint">{m.incurred ? formatMoney(m.incurred) : '—'}</td>
                  <td>
                    <div className="stack" style={{ gap: 'var(--s-1)' }}>
                      <Bar value={m.billed} peak={peak} />
                      <Bar value={m.collected} peak={peak} tone="rgb(var(--info-rgb) / 0.55)" />
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="faint" style={{ marginTop: 'var(--s-3)', marginBottom: 0 }}>
          Cost is placed in the month the work happened, not the month somebody keyed it —
          otherwise the trend shows the bookkeeping rather than the business.
        </p>
      </div>
    </div>
  );
}

// ── Project profitability ────────────────────────────────────────────────────

interface ProfitRow {
  job: { id: string; number: string; name: string; status: string; type: string };
  customer: { id: string; name: string };
  projectManager: string | null;
  contractValue: number;
  budgetedCost: number;
  actualCost: number;
  committed: number;
  incurred: number;
  available: number;
  billed: number;
  collected: number;
  expectedProfit: number;
  expectedMarginPct: number;
  runningProfit: number;
  runningMarginPct: number;
  costUsedPct: number;
  billedPct: number;
  tooEarly: boolean;
  overspending: boolean;
}

export function Profitability() {
  const [type, setType] = useState('');
  const [data, setData] = useState<{
    rows: ProfitRow[];
    totals: Record<string, number>;
    watchlist: { overspending: string[]; thinMargin: string[]; unbilled: string[] };
  } | null>(null);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    setError(null);
    api
      .get<NonNullable<typeof data>>(`/insights/profitability${qs({ type })}`)
      .then(setData)
      .catch(setError);
  }, [type]);

  if (error) return <ErrorBox error={error} />;
  if (!data) return <Loading />;

  const flagged = new Set(data.watchlist.overspending);

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Project Profitability</h1>
          <p>
            <strong>Expected margin</strong> comes from the budget and means something on day one.
            Running margin comes from what has actually been spent and means nothing until a job is
            well under way — so a job too early to judge says so rather than reporting 99%.
          </p>
        </div>
        <div className="row">
          <Field label="Kind">
            <select value={type} onChange={(e) => setType(e.target.value)}>
              <option value="">Everything</option>
              <option value="PROJECT">Delivery projects</option>
              <option value="SERVICE_CONTRACT">Service contracts</option>
            </select>
          </Field>
          <ExportButton path={`/insights/profitability.csv${qs({ type })}`} />
        </div>
      </div>

      <div className="grid grid-4" style={{ marginBottom: 'var(--s-5)' }}>
        <Tile label="Contract value" value={formatMoney(data.totals.contractValue)} sub={`${data.totals.jobs} job${data.totals.jobs === 1 ? '' : 's'}`} />
        <Tile label="Budgeted cost" value={formatMoney(data.totals.budgetedCost)} sub="what they were costed at" />
        <Tile
          label="Expected profit"
          value={formatMoney(data.totals.expectedProfit)}
          sub={`${data.totals.expectedMarginPct.toFixed(1)}% margin`}
          tone={data.totals.expectedProfit < 0 ? 'var(--danger)' : 'var(--neon)'}
        />
        <Tile
          label="Billed / collected"
          value={formatMoney(data.totals.billed)}
          sub={`${formatMoney(data.totals.collected)} in the bank`}
        />
      </div>

      {(data.watchlist.overspending.length > 0 ||
        data.watchlist.thinMargin.length > 0 ||
        data.watchlist.unbilled.length > 0) && (
        <div className="card">
          <h3 className="card-title">Worth a look</h3>
          <div className="stack">
            {data.watchlist.overspending.length > 0 && (
              <div>
                <span className="badge warn">spending ahead of billing</span>{' '}
                <span className="mono faint">{data.watchlist.overspending.join(', ')}</span>
                <div className="section-label">
                  Cost is running more than ten points ahead of what has been billed — the job is
                  funding itself out of the company's cash.
                </div>
              </div>
            )}
            {data.watchlist.thinMargin.length > 0 && (
              <div>
                <span className="badge warn">under 10% expected margin</span>{' '}
                <span className="mono faint">{data.watchlist.thinMargin.join(', ')}</span>
              </div>
            )}
            {data.watchlist.unbilled.length > 0 && (
              <div>
                <span className="badge warn">work done, nothing billed</span>{' '}
                <span className="mono faint">{data.watchlist.unbilled.join(', ')}</span>
              </div>
            )}
          </div>
        </div>
      )}

      <div className="card">
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>Project</th>
                <th>Manager</th>
                <th className="right">Contract</th>
                <th className="right">Budget</th>
                <th className="right">Spent</th>
                <th className="right">Available</th>
                <th className="right">Expected margin</th>
                <th className="right">Cost used</th>
                <th className="right">Billed</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {data.rows.map((r) => (
                <tr key={r.job.id}>
                  <td>
                    <Link to={`/g-ops/projects/${r.job.id}`} className="mono">
                      {r.job.number}
                    </Link>
                    <div className="faint">{r.customer.name}</div>
                  </td>
                  <td className="faint">{r.projectManager ?? '—'}</td>
                  <td className="right mono">{formatMoney(r.contractValue)}</td>
                  <td className="right mono faint">{formatMoney(r.budgetedCost)}</td>
                  <td className="right mono">{formatMoney(r.actualCost)}</td>
                  <td className="right mono">
                    <span className={r.available < 0 ? 'warn' : ''}>{formatMoney(r.available)}</span>
                  </td>
                  <td className="right mono">
                    <span className={r.expectedMarginPct < 10 ? 'warn' : ''}>
                      {r.expectedMarginPct.toFixed(1)}%
                    </span>
                    <div className="section-label">
                      {formatMoney(r.expectedProfit)}
                    </div>
                  </td>
                  <td className="right mono">{r.costUsedPct.toFixed(0)}%</td>
                  <td className="right mono">{r.billedPct.toFixed(0)}%</td>
                  <td>
                    {flagged.has(r.job.number) ? (
                      <span className="badge warn" title="Cost running ahead of billing">
                        watch
                      </span>
                    ) : r.tooEarly ? (
                      <span className="badge" title="Too little spent for the running margin to mean anything">
                        early
                      </span>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <th colSpan={2}>Total</th>
                <th className="right mono">{formatMoney(data.totals.contractValue)}</th>
                <th className="right mono">{formatMoney(data.totals.budgetedCost)}</th>
                <th className="right mono">{formatMoney(data.totals.actualCost)}</th>
                <th />
                <th className="right mono">{data.totals.expectedMarginPct.toFixed(1)}%</th>
                <th colSpan={3} />
              </tr>
            </tfoot>
          </table>
        </div>
      </div>
    </div>
  );
}
