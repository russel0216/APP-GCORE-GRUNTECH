import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, qs } from '../../lib/api';
import { Empty, ErrorBox, Field, Loading, formatDate, formatMoney } from '../../components/ui';
import { Tile, RangePicker, ExportButton, Bar } from './Overview';

/**
 * The four reports that answer a question somebody actually asks.
 *
 * Sales analytics: is the pipeline real, and who is converting it.
 * Cash forecast: when does money move, including the part waiting on us.
 * Inventory analytics: where is the money sitting still.
 * Performance: what did people produce, and where is work stuck.
 */

// ── Sales analytics ──────────────────────────────────────────────────────────

interface Pipeline {
  range: { from: string; to: string };
  funnel: { stage: string; count: number; value: number }[];
  totals: {
    leads: number;
    openQuotations: number;
    openValue: number;
    weightedValue: number;
    won: number;
    wonValue: number;
    lost: number;
    lostValue: number;
    winRatePct: number;
    medianDaysToDecide: number | null;
  };
  people: {
    id: string;
    name: string;
    leads: number;
    quotations: number;
    quotedValue: number;
    won: number;
    wonValue: number;
    lost: number;
    winRatePct: number;
    medianDaysToDecide: number | null;
  }[];
  sources: { source: string; leads: number; won: number; value: number }[];
  lostReasons: { reason: string; count: number }[];
  openQuotations: {
    id: string;
    number: string;
    subject: string;
    customer: { id: string; name: string };
    owner: string;
    outcome: string;
    probability: number;
    value: number;
    weighted: number;
    ageDays: number;
  }[];
}

export function SalesAnalytics() {
  const thisYear = new Date().getFullYear();
  const [from, setFrom] = useState(`${thisYear}-01-01`);
  const [to, setTo] = useState(new Date().toISOString().slice(0, 10));
  const [data, setData] = useState<Pipeline | null>(null);
  const [error, setError] = useState<unknown>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setData(await api.get<Pipeline>(`/insights/pipeline${qs({ from, to })}`));
    } catch (err) {
      setError(err);
    }
  }, [from, to]);

  useEffect(() => {
    load();
  }, [load]);

  if (error) return <ErrorBox error={error} />;
  if (!data) return <Loading />;

  const funnelPeak = Math.max(1, ...data.funnel.map((f) => f.count));

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Sales Analytics</h1>
          <p>
            The weighted figure is the one to plan against: every open quotation at the
            salesperson's own odds of winning it. The raw total is what would happen if everything
            landed, which it will not.
          </p>
        </div>
        <div className="row">
          <RangePicker
            from={from}
            to={to}
            onChange={(f, t) => {
              setFrom(f);
              setTo(t);
            }}
          />
          <ExportButton path={`/insights/pipeline.csv${qs({ from, to })}`} />
        </div>
      </div>

      <div className="grid grid-4" style={{ marginBottom: 18 }}>
        <Tile
          label="Open pipeline"
          value={formatMoney(data.totals.openValue)}
          sub={`${data.totals.openQuotations} quotations out`}
        />
        <Tile
          label="Weighted"
          value={formatMoney(data.totals.weightedValue)}
          sub="what to plan against"
          tone="var(--neon)"
        />
        <Tile
          label="Won in range"
          value={formatMoney(data.totals.wonValue)}
          sub={`${data.totals.won} of ${data.totals.won + data.totals.lost} decided — ${data.totals.winRatePct.toFixed(0)}%`}
        />
        <Tile
          label="Median decision"
          value={data.totals.medianDaysToDecide === null ? '—' : `${data.totals.medianDaysToDecide} days`}
          sub="from submission to a yes or no"
        />
      </div>

      <div className="grid grid-2">
        <div className="card">
          <h3 className="card-title">The funnel</h3>
          <p className="muted">
            Lead statuses collapse into the stages people report on. Ten stages make the drop-off
            impossible to see.
          </p>
          <div className="table-wrap">
            <table className="data">
              <tbody>
                {data.funnel.map((f) => (
                  <tr key={f.stage}>
                    <td style={{ width: 110 }}>{f.stage}</td>
                    <td className="right mono" style={{ width: 60 }}>
                      {f.count}
                    </td>
                    <td className="right mono faint" style={{ width: 130 }}>
                      {f.value ? formatMoney(f.value) : '—'}
                    </td>
                    <td>
                      <Bar
                        value={f.count}
                        peak={funnelPeak}
                        tone={
                          f.stage === 'Won'
                            ? 'rgba(57, 255, 157, 0.55)'
                            : f.stage === 'Lost'
                              ? 'rgba(255, 107, 138, 0.5)'
                              : undefined
                        }
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <div className="card">
          <h3 className="card-title">Where the work comes from</h3>
          {data.sources.length === 0 ? (
            <p className="muted" style={{ marginBottom: 0 }}>
              No leads in this range.
            </p>
          ) : (
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    <th>Source</th>
                    <th className="right">Leads</th>
                    <th className="right">Won</th>
                    <th className="right">Estimated</th>
                  </tr>
                </thead>
                <tbody>
                  {data.sources.map((s) => (
                    <tr key={s.source}>
                      <td>{s.source}</td>
                      <td className="right mono">{s.leads}</td>
                      <td className="right mono">{s.won}</td>
                      <td className="right mono faint">{s.value ? formatMoney(s.value) : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      <div className="card">
        <h3 className="card-title">By salesperson</h3>
        {data.people.length === 0 ? (
          <p className="muted" style={{ marginBottom: 0 }}>
            Nothing in this range.
          </p>
        ) : (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Who</th>
                  <th className="right">Leads</th>
                  <th className="right">Quoted</th>
                  <th className="right">Quoted value</th>
                  <th className="right">Won</th>
                  <th className="right">Won value</th>
                  <th className="right">Win rate</th>
                  <th className="right">Median decision</th>
                </tr>
              </thead>
              <tbody>
                {data.people.map((p) => (
                  <tr key={p.id}>
                    <td>{p.name}</td>
                    <td className="right mono">{p.leads}</td>
                    <td className="right mono">{p.quotations}</td>
                    <td className="right mono faint">{formatMoney(p.quotedValue)}</td>
                    <td className="right mono">{p.won}</td>
                    <td className="right mono">{formatMoney(p.wonValue)}</td>
                    <td className="right mono">
                      {p.won + p.lost === 0 ? (
                        <span className="faint">nothing decided</span>
                      ) : (
                        `${p.winRatePct.toFixed(0)}%`
                      )}
                    </td>
                    <td className="right mono faint">
                      {p.medianDaysToDecide === null ? '—' : `${p.medianDaysToDecide}d`}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="faint" style={{ marginTop: 10, marginBottom: 0 }}>
          A win rate counts only what has been decided. A quotation still sitting with a customer
          is neither a win nor a loss, and counting it as either flatters or punishes unfairly.
        </p>
      </div>

      <div className="grid grid-2">
        <div className="card">
          <h3 className="card-title">Open quotations, by what they are worth</h3>
          {data.openQuotations.length === 0 ? (
            <p className="muted" style={{ marginBottom: 0 }}>
              Nothing outstanding.
            </p>
          ) : (
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    <th>Quotation</th>
                    <th className="right">Value</th>
                    <th className="right">Odds</th>
                    <th className="right">Weighted</th>
                    <th className="right">Age</th>
                  </tr>
                </thead>
                <tbody>
                  {data.openQuotations.slice(0, 20).map((q) => (
                    <tr key={q.id}>
                      <td>
                        <Link to={`/g-ops/quotations/${q.id}`} className="mono">
                          {q.number}
                        </Link>
                        <div className="faint">
                          {q.customer.name} · {q.owner}
                        </div>
                      </td>
                      <td className="right mono">{formatMoney(q.value)}</td>
                      <td className="right mono faint">{q.probability}%</td>
                      <td className="right mono">{formatMoney(q.weighted)}</td>
                      <td className="right">
                        <span className={q.ageDays > 60 ? 'warn' : 'faint'}>{q.ageDays}d</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <div className="card">
          <h3 className="card-title">Why we lost</h3>
          {data.lostReasons.length === 0 ? (
            <p className="muted" style={{ marginBottom: 0 }}>
              Nothing lost in this range.
            </p>
          ) : (
            <div className="table-wrap">
              <table className="data">
                <tbody>
                  {data.lostReasons.map((r) => (
                    <tr key={r.reason}>
                      <td>{r.reason}</td>
                      <td className="right mono">{r.count}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <p className="faint" style={{ marginTop: 10, marginBottom: 0 }}>
            "Not recorded" is the most expensive answer on this list: a loss nobody explained
            cannot be learned from.
          </p>
        </div>
      </div>
    </div>
  );
}

// ── Cash forecast ────────────────────────────────────────────────────────────

interface Forecast {
  asOf: string;
  buckets: {
    label: string;
    invoiced: number;
    unbilled: number;
    payable: number;
    reimbursable: number;
    committed: number;
    net: number;
  }[];
  cumulative: { label: string; net: number; cumulative: number }[];
  totals: {
    invoiced: number;
    unbilled: number;
    payable: number;
    reimbursable: number;
    committed: number;
    net: number;
  };
  uncleared: { in: number; out: number; rows: { number: string; kind: string; amount: number }[] };
  ourMove: {
    billingsAwaitingInvoice: number;
    billingsAwaitingInvoiceValue: number;
    rows: { id: string; number: string; job: string; customer: string; value: number; waitingDays: number }[];
  };
}

export function CashForecast() {
  const [data, setData] = useState<Forecast | null>(null);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    api.get<Forecast>('/insights/cash-forecast').then(setData).catch(setError);
  }, []);

  if (error) return <ErrorBox error={error} />;
  if (!data) return <Loading />;

  const peak = Math.max(
    1,
    ...data.buckets.flatMap((b) => [b.invoiced + b.unbilled, b.payable + b.reimbursable + b.committed]),
  );

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Cash Forecast</h1>
          <p>
            Wider than the A/R view in one way that matters: it also counts work approved but not
            yet invoiced, and purchase orders nobody has billed us for. Both are cash a decision
            away, and a forecast built only from invoices flatters the position on both sides.
          </p>
        </div>
        <ExportButton path="/insights/cash-forecast.csv" />
      </div>

      <div className="grid grid-4" style={{ marginBottom: 18 }}>
        <Tile label="Invoiced, owed to us" value={formatMoney(data.totals.invoiced)} sub="waiting on customers" />
        <Tile
          label="Earned, not invoiced"
          value={formatMoney(data.totals.unbilled)}
          sub="waiting on us"
          tone={data.totals.unbilled > 0 ? 'var(--warn)' : undefined}
        />
        <Tile
          label="Owed by us"
          value={formatMoney(data.totals.payable + data.totals.reimbursable)}
          sub={`plus ${formatMoney(data.totals.committed)} committed on orders`}
        />
        <Tile
          label="Net position"
          value={formatMoney(data.totals.net)}
          sub="everything in, less everything out"
          tone={data.totals.net < 0 ? 'var(--danger)' : 'var(--neon)'}
        />
      </div>

      <div className="card">
        <h3 className="card-title">When it moves</h3>
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>When</th>
                <th className="right">Invoiced</th>
                <th className="right">Uninvoiced</th>
                <th className="right">Payable</th>
                <th className="right">Claims</th>
                <th className="right">Committed</th>
                <th className="right">Net</th>
                <th className="right">Running</th>
                <th style={{ width: '22%' }} />
              </tr>
            </thead>
            <tbody>
              {data.buckets.map((b, i) => (
                <tr key={b.label}>
                  <td className={b.label === 'Overdue' ? 'warn' : ''}>{b.label}</td>
                  <td className="right mono">{b.invoiced ? formatMoney(b.invoiced) : '—'}</td>
                  <td className="right mono faint">{b.unbilled ? formatMoney(b.unbilled) : '—'}</td>
                  <td className="right mono">{b.payable ? formatMoney(b.payable) : '—'}</td>
                  <td className="right mono faint">{b.reimbursable ? formatMoney(b.reimbursable) : '—'}</td>
                  <td className="right mono faint">{b.committed ? formatMoney(b.committed) : '—'}</td>
                  <td className="right mono">
                    <span className={b.net < 0 ? 'warn' : ''}>{formatMoney(b.net)}</span>
                  </td>
                  <td className="right mono">
                    <span className={data.cumulative[i].cumulative < 0 ? 'warn' : ''}>
                      {formatMoney(data.cumulative[i].cumulative)}
                    </span>
                  </td>
                  <td>
                    <div className="stack" style={{ gap: 3 }}>
                      <Bar value={b.invoiced + b.unbilled} peak={peak} />
                      <Bar
                        value={b.payable + b.reimbursable + b.committed}
                        peak={peak}
                        tone="rgba(240, 180, 41, 0.5)"
                      />
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="faint" style={{ marginTop: 10, marginBottom: 0 }}>
          Committed is money promised on issued purchase orders that no supplier has billed for
          yet. It will land as a payable; leaving it out makes the position look better than it is.
        </p>
      </div>

      <div className="grid grid-2">
        <div className="card">
          <h3 className="card-title">
            Waiting on us — {formatMoney(data.ourMove.billingsAwaitingInvoiceValue)}
          </h3>
          {data.ourMove.rows.length === 0 ? (
            <p className="muted" style={{ marginBottom: 0 }}>
              Every approved billing has been invoiced.
            </p>
          ) : (
            <>
              <p className="muted">
                Work approved and priced, with no invoice raised. This is the fastest cash in the
                building and it needs nobody's permission but ours.
              </p>
              <div className="table-wrap">
                <table className="data">
                  <tbody>
                    {data.ourMove.rows.map((r) => (
                      <tr key={r.id}>
                        <td>
                          <span className="mono">{r.number}</span>
                          <div className="faint">
                            {r.customer} · {r.job}
                          </div>
                        </td>
                        <td className="right mono">{formatMoney(r.value)}</td>
                        <td className="right">
                          <span className={r.waitingDays > 7 ? 'warn' : 'faint'}>{r.waitingDays}d</span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <Link className="btn btn-sm" to="/g-fin/ar" style={{ marginTop: 10 }}>
                Raise them
              </Link>
            </>
          )}
        </div>

        <div className="card">
          <h3 className="card-title">Uncleared</h3>
          {data.uncleared.rows.length === 0 ? (
            <p className="muted" style={{ marginBottom: 0 }}>
              Nothing waiting to clear.
            </p>
          ) : (
            <>
              <p className="muted">
                {formatMoney(data.uncleared.in)} in and {formatMoney(data.uncleared.out)} out,
                counted in neither column above until the bank says so.
              </p>
              <div className="table-wrap">
                <table className="data">
                  <tbody>
                    {data.uncleared.rows.map((p) => (
                      <tr key={p.number}>
                        <td className="mono">{p.number}</td>
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

// ── Inventory analytics ──────────────────────────────────────────────────────

interface InventoryAnalytics {
  totalValue: number;
  lines: number;
  byCategory: { category: string; value: number; lines: number }[];
  slowMovers: {
    item: { id: string; code: string; name: string; unit: string };
    quantity: number;
    averageCost: number;
    value: number;
    lastMovedAt: string | null;
    daysSinceMoved: number | null;
  }[];
  slowMoverValue: number;
  slowMoverShare: number;
  sinceDays: number;
  belowReorder: {
    item: { id: string; code: string; name: string; unit: string };
    warehouse: { id: string; name: string };
    quantity: number;
    borrowed: number;
    available: number;
    reorderLevel: number;
  }[];
  throughput: { months: number; issuedValue: number; monthlyIssue: number; monthsOfStock: number | null };
}

export function InventoryAnalytics() {
  const [sinceDays, setSinceDays] = useState(90);
  const [data, setData] = useState<InventoryAnalytics | null>(null);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    setError(null);
    api
      .get<InventoryAnalytics>(`/insights/inventory${qs({ sinceDays })}`)
      .then(setData)
      .catch(setError);
  }, [sinceDays]);

  if (error) return <ErrorBox error={error} />;
  if (!data) return <Loading />;

  const catPeak = Math.max(1, ...data.byCategory.map((c) => c.value));

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Inventory Analytics</h1>
          <p>
            Where the money is sitting, and where it is sitting <em>still</em>. Slow movers are
            ranked by value, not by age — a thousand idle washers matter less than one idle
            compressor.
          </p>
        </div>
        <div className="row">
          <Field label="Idle for at least">
            <select value={sinceDays} onChange={(e) => setSinceDays(Number(e.target.value))}>
              <option value={30}>30 days</option>
              <option value={90}>90 days</option>
              <option value={180}>6 months</option>
              <option value={365}>a year</option>
            </select>
          </Field>
          <ExportButton path={`/insights/inventory.csv${qs({ sinceDays })}`} />
        </div>
      </div>

      <div className="grid grid-4" style={{ marginBottom: 18 }}>
        <Tile label="Stock value" value={formatMoney(data.totalValue)} sub={`${data.lines} item lines`} />
        <Tile
          label="Not moving"
          value={formatMoney(data.slowMoverValue)}
          sub={`${data.slowMoverShare.toFixed(0)}% of stock, idle ${data.sinceDays}+ days`}
          tone={data.slowMoverShare > 25 ? 'var(--warn)' : undefined}
        />
        <Tile
          label="Issued per month"
          value={formatMoney(data.throughput.monthlyIssue)}
          sub={`average over ${data.throughput.months} months`}
        />
        <Tile
          label="Months of stock"
          value={data.throughput.monthsOfStock === null ? '—' : data.throughput.monthsOfStock.toFixed(1)}
          sub="at the recent rate of issuing"
          tone={
            data.throughput.monthsOfStock !== null && data.throughput.monthsOfStock > 12
              ? 'var(--warn)'
              : undefined
          }
        />
      </div>

      <div className="grid grid-2">
        <div className="card">
          <h3 className="card-title">Where it is sitting</h3>
          {data.byCategory.length === 0 ? (
            <p className="muted" style={{ marginBottom: 0 }}>
              No stock on hand.
            </p>
          ) : (
            <div className="table-wrap">
              <table className="data">
                <tbody>
                  {data.byCategory.map((c) => (
                    <tr key={c.category}>
                      <td>{c.category}</td>
                      <td className="right mono faint" style={{ width: 60 }}>
                        {c.lines}
                      </td>
                      <td className="right mono" style={{ width: 130 }}>
                        {formatMoney(c.value)}
                      </td>
                      <td style={{ width: '35%' }}>
                        <Bar value={c.value} peak={catPeak} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <div className="card">
          <h3 className="card-title">Below reorder level</h3>
          {data.belowReorder.length === 0 ? (
            <p className="muted" style={{ marginBottom: 0 }}>
              Nothing is below its reorder level.
            </p>
          ) : (
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    <th>Item</th>
                    <th className="right">Available</th>
                    <th className="right">Reorder at</th>
                  </tr>
                </thead>
                <tbody>
                  {data.belowReorder.map((r) => (
                    <tr key={`${r.item.id}-${r.warehouse.id}`}>
                      <td>
                        <Link to={`/g-chain/inventory/${r.item.id}`}>{r.item.name}</Link>
                        <div className="faint mono">
                          {r.item.code} · {r.warehouse.name}
                        </div>
                      </td>
                      <td className="right mono">
                        <span className="warn">
                          {r.available} {r.item.unit}
                        </span>
                        {r.borrowed > 0 && (
                          <div className="section-label">
                            {r.borrowed} out on loan
                          </div>
                        )}
                      </td>
                      <td className="right mono faint">{r.reorderLevel}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      <div className="card">
        <h3 className="card-title">Not moving — biggest first</h3>
        {data.slowMovers.length === 0 ? (
          <p className="muted" style={{ marginBottom: 0 }}>
            Everything on hand has moved in the last {data.sinceDays} days.
          </p>
        ) : (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Item</th>
                  <th className="right">On hand</th>
                  <th className="right">Average cost</th>
                  <th className="right">Value</th>
                  <th>Last moved</th>
                  <th className="right">Idle</th>
                </tr>
              </thead>
              <tbody>
                {data.slowMovers.map((r) => (
                  <tr key={r.item.id}>
                    <td>
                      <Link to={`/g-chain/inventory/${r.item.id}`}>{r.item.name}</Link>
                      <div className="faint mono">{r.item.code}</div>
                    </td>
                    <td className="right mono">
                      {r.quantity} {r.item.unit}
                    </td>
                    <td className="right mono faint">{formatMoney(r.averageCost)}</td>
                    <td className="right mono">{formatMoney(r.value)}</td>
                    <td className="faint">{r.lastMovedAt ? formatDate(r.lastMovedAt) : 'never'}</td>
                    <td className="right">
                      <span className={(r.daysSinceMoved ?? 0) > 365 ? 'warn' : 'faint'}>
                        {r.daysSinceMoved === null ? '—' : `${r.daysSinceMoved}d`}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Performance ──────────────────────────────────────────────────────────────

interface Performance {
  range: { from: string; to: string };
  sales: { id: string; name: string; raised: number; won: number; wonValue: number }[];
  delivery: {
    id: string;
    name: string;
    active: number;
    delivered: number;
    onTime: number;
    finished: number;
    contractValue: number;
    billed: number;
    overBudget: number;
    onTimePct: number;
  }[];
  service: { id: string; name: string; filed: number; approved: number; returned: number }[];
  bottleneck: {
    total: number;
    oldestDays: number;
    byApprover: { approver: string; count: number; oldestDays: number; value: number }[];
    rows: {
      id: string;
      documentType: string;
      documentNumber: string | null;
      subject: string;
      amount: number | null;
      requester: string;
      waitingOn: string;
      step: string;
      waitingDays: number;
    }[];
  };
}

export function PerformanceReport() {
  const thisYear = new Date().getFullYear();
  const [from, setFrom] = useState(`${thisYear}-01-01`);
  const [to, setTo] = useState(new Date().toISOString().slice(0, 10));
  const [data, setData] = useState<Performance | null>(null);
  const [error, setError] = useState<unknown>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setData(await api.get<Performance>(`/insights/performance${qs({ from, to })}`));
    } catch (err) {
      setError(err);
    }
  }, [from, to]);

  useEffect(() => {
    load();
  }, [load]);

  if (error) return <ErrorBox error={error} />;
  if (!data) return <Loading />;

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Performance</h1>
          <p>
            What people produced, and where work is stuck. Deliberately about output — nothing here
            is drawn from attendance: lateness and leave stay in G-HR behind HR's own permissions,
            and aggregating them into a management league table would turn a payroll record into
            something else without anybody deciding to.
          </p>
        </div>
        <div className="row">
          <RangePicker
            from={from}
            to={to}
            onChange={(f, t) => {
              setFrom(f);
              setTo(t);
            }}
          />
          <ExportButton path="/insights/performance.csv" label="Export approvals" />
        </div>
      </div>

      {data.bottleneck.total > 0 && (
        <div className={`alert ${data.bottleneck.oldestDays > 7 ? 'warn' : 'info'}`}>
          {data.bottleneck.total} document{data.bottleneck.total === 1 ? '' : 's'} waiting on an
          approval, the oldest for {data.bottleneck.oldestDays} days. An approval queue says more
          about how a company runs than any individual's count does.
        </div>
      )}

      <div className="card">
        <h3 className="card-title">Where work is stuck</h3>
        {data.bottleneck.byApprover.length === 0 ? (
          <p className="muted" style={{ marginBottom: 0 }}>
            Nothing is waiting on anybody.
          </p>
        ) : (
          <>
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    <th>Waiting on</th>
                    <th className="right">Documents</th>
                    <th className="right">Value held up</th>
                    <th className="right">Oldest</th>
                  </tr>
                </thead>
                <tbody>
                  {data.bottleneck.byApprover.map((a) => (
                    <tr key={a.approver}>
                      <td>{a.approver}</td>
                      <td className="right mono">{a.count}</td>
                      <td className="right mono">{a.value ? formatMoney(a.value) : '—'}</td>
                      <td className="right">
                        <span className={a.oldestDays > 7 ? 'warn' : 'faint'}>{a.oldestDays}d</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <details style={{ marginTop: 12 }}>
              <summary className="faint" style={{ cursor: 'pointer' }}>
                Every waiting document
              </summary>
              <div className="table-wrap" style={{ marginTop: 10 }}>
                <table className="data">
                  <thead>
                    <tr>
                      <th>Document</th>
                      <th>Raised by</th>
                      <th>Waiting on</th>
                      <th className="right">Amount</th>
                      <th className="right">Days</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.bottleneck.rows.map((r) => (
                      <tr key={r.id}>
                        <td>
                          <span className="mono">{r.documentNumber ?? r.documentType}</span>
                          <div className="faint">{r.subject}</div>
                        </td>
                        <td className="faint">{r.requester}</td>
                        <td>
                          {r.waitingOn}
                          <div className="section-label">
                            {r.step}
                          </div>
                        </td>
                        <td className="right mono">{r.amount ? formatMoney(r.amount) : '—'}</td>
                        <td className="right">
                          <span className={r.waitingDays > 7 ? 'warn' : 'faint'}>{r.waitingDays}</span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </details>
          </>
        )}
      </div>

      <div className="grid grid-2">
        <div className="card">
          <h3 className="card-title">Sales</h3>
          {data.sales.length === 0 ? (
            <p className="muted" style={{ marginBottom: 0 }}>
              No quotations raised in this range.
            </p>
          ) : (
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    <th>Who</th>
                    <th className="right">Raised</th>
                    <th className="right">Won</th>
                    <th className="right">Won value</th>
                  </tr>
                </thead>
                <tbody>
                  {data.sales.map((p) => (
                    <tr key={p.id}>
                      <td>{p.name}</td>
                      <td className="right mono">{p.raised}</td>
                      <td className="right mono">{p.won}</td>
                      <td className="right mono">{formatMoney(p.wonValue)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <div className="card">
          <h3 className="card-title">Service</h3>
          {data.service.length === 0 ? (
            <p className="muted" style={{ marginBottom: 0 }}>
              No service reports filed in this range.
            </p>
          ) : (
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    <th>Who</th>
                    <th className="right">Filed</th>
                    <th className="right">Approved</th>
                    <th className="right">Returned</th>
                  </tr>
                </thead>
                <tbody>
                  {data.service.map((p) => (
                    <tr key={p.id}>
                      <td>{p.name}</td>
                      <td className="right mono">{p.filed}</td>
                      <td className="right mono">{p.approved}</td>
                      <td className="right mono">
                        <span className={p.returned > 0 ? 'warn' : 'faint'}>{p.returned}</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      <div className="card">
        <h3 className="card-title">Delivery</h3>
        {data.delivery.length === 0 ? (
          <Empty title="No projects with a manager assigned" />
        ) : (
          <>
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    <th>Project manager</th>
                    <th className="right">Active</th>
                    <th className="right">Delivered</th>
                    <th className="right">On time</th>
                    <th className="right">Over budget</th>
                    <th className="right">Contract value</th>
                    <th className="right">Billed</th>
                  </tr>
                </thead>
                <tbody>
                  {data.delivery.map((m) => (
                    <tr key={m.id}>
                      <td>{m.name}</td>
                      <td className="right mono">{m.active}</td>
                      <td className="right mono">{m.delivered}</td>
                      <td className="right mono">
                        {m.finished === 0 ? (
                          <span className="faint">no target dates</span>
                        ) : (
                          `${m.onTimePct.toFixed(0)}%`
                        )}
                      </td>
                      <td className="right mono">
                        <span className={m.overBudget > 0 ? 'warn' : 'faint'}>{m.overBudget}</span>
                      </td>
                      <td className="right mono">{formatMoney(m.contractValue)}</td>
                      <td className="right mono faint">{formatMoney(m.billed)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="faint" style={{ marginTop: 10, marginBottom: 0 }}>
              On time is only asked of jobs that finished and had a target date to finish by.
              Scoring somebody against a date nobody set is worse than not scoring them.
            </p>
          </>
        )}
      </div>
    </div>
  );
}
