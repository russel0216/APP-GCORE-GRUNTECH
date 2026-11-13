import { useEffect, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { api, qs } from '../lib/api';
import { ErrorBox, Loading, formatCompactMoney, formatMoney } from '../components/ui';
import { GroupedBars, Panel, Stat, type BarGroup } from '../components/charts';

/**
 * The G-OPS dashboard's sales performance (2026-11-08, the owner's
 * `G-OPS_Dashboard_1.pdf`): booked sales orders BEFORE VAT, in pesos, read
 * from `GET /gops/sales` — the Sales Order report's own rows, so the two
 * agree.
 *
 * A SUMMARY since 2026-11-13 (the owner's call: the dashboard repeated the
 * Sales Order report): the three cards and the month-by-month bars against
 * last year, then — after whatever the dashboard puts between (`children`,
 * its Sales / Project / Aftermarket counts) — the top five customers and the
 * top five salespeople, each with "See all" opening the report. The two
 * flows and the month-by-month grid live in the Sales Order report alone.
 *
 * The section shows only to a reader of sales orders — the API answers
 * `null` to anyone else — and a View Own holder sees their own orders alone,
 * as on the list. Every customer, person and team opens the list on its
 * slice.
 */

interface Sales {
  from: string;
  to: string;
  year: number;
  previousYear: number;
  total: number;
  orders: number;
  months: { key: string; label: string; current: number; previous: number; currentOrders: number; state: 'done' | 'partial' | 'future' }[];
  customers: { id: string; name: string; orders: number; revenue: number; to: string }[];
  people: { id: string; name: string; team: string | null; month: number; range: number; orders: number; to: string }[];
  currentMonth: { key: string; label: string; from: string; to: string };
  sankey: {
    root: { label: string; value: number };
    teams: { id: string; label: string; name: string; value: number; pct: number; to: string }[];
    people: { id: string; label: string; value: number; pct: number; to: string }[];
    links: { team: string; person: string; value: number }[];
  };
  customerSankey?: Omit<Sales['sankey'], 'people'> & { people: { id: string; of?: string; label: string; value: number; pct: number; to: string }[] };
}

const TOP = 5;

export function OpsSales({ from, to, children }: { from: string; to: string; children?: ReactNode }) {
  const [data, setData] = useState<Sales | null | undefined>(undefined);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => {
    setError(null);
    api
      .get<Sales | null>(`/gops/sales${qs({ from, to })}`)
      .then(setData)
      .catch(setError);
  }, [from, to]);

  // The dashboard's own panels show whatever becomes of the sales figures.
  if (error)
    return (
      <>
        <ErrorBox error={error} />
        {children}
      </>
    );
  if (data === undefined)
    return (
      <>
        <Loading label="Adding up the sales orders…" />
        {children}
      </>
    );
  if (data === null) return <>{children}</>;
  const report = `/g-ops/sales-orders/report?from=${data.from}&to=${data.to}`;
  const seeAll = (
    <Link to={report} className="btn btn-sm">
      See all
    </Link>
  );

  const groups: BarGroup[] = data.months.map((m) => ({
    label: m.label,
    values: [m.current, m.previous],
    mark: m.state === 'partial' ? '*' : undefined,
    faint: m.state !== 'done',
    note: m.state === 'partial' ? `* ${m.label} ${data.year} is still running` : undefined,
  }));
  // Like against like: this year's months so far against the SAME months of
  // last year — never a part-year against a whole one.
  const soFar = data.months.filter((m) => m.state !== 'future');
  const ytd = soFar.reduce((s, m) => s + m.current, 0);
  const prevSame = soFar.reduce((s, m) => s + m.previous, 0);
  const prevTotal = data.months.reduce((s, m) => s + m.previous, 0);
  const span = soFar.length ? `${soFar[0].label}–${soFar[soFar.length - 1].label}` : '';
  const change = prevSame > 0 ? ((ytd - prevSame) / prevSame) * 100 : null;

  return (
    <>
      <Panel
        title={`Monthly sales performance — ${data.year} against ${data.previousYear}`}
        blurb="Booked sales orders before VAT, month by month, in pesos. A cancelled order books nothing."
        action={
          <Link to={report} className="btn btn-sm">
            Open the Sales Order report
          </Link>
        }
      >
        <div className="kpi-grid">
          <Stat label="Booked in the range" value={formatMoney(data.total)} figure sub={`${data.orders} order${data.orders === 1 ? '' : 's'}, ${data.from} to ${data.to}`} />
          <Stat label={`${data.year} so far`} value={formatMoney(ytd)} figure sub={`${span}, whole months`} />
          <Stat
            label={`${data.previousYear}, same months`}
            value={formatMoney(prevSame)}
            figure
            sub={change === null ? `${formatMoney(prevTotal)} over the whole of ${data.previousYear}` : `${change >= 0 ? '+' : ''}${change.toFixed(1)}% this year against ${span} ${data.previousYear}`}
          />
        </div>
        <GroupedBars
          groups={groups}
          series={[
            { label: `${data.year} (current year)`, tone: 'neon' },
            { label: `${data.previousYear} (previous year)`, tone: 'magenta' },
          ]}
          format={formatCompactMoney}
          caption="Jan – Dec, before VAT"
        />
      </Panel>

      {children}

      <div className="grid grid-2">
        <Panel title={`Top ${TOP} customers`} blurb={`${data.from} to ${data.to}, before VAT`} action={seeAll}>
          {data.customers.length === 0 ? (
            <div className="chart-empty">Nothing booked in the range.</div>
          ) : (
            <table className="data">
              <thead>
                <tr>
                  <th>#</th>
                  <th>Customer</th>
                  <th className="num">Orders</th>
                  <th className="num">Revenue</th>
                </tr>
              </thead>
              <tbody>
                {data.customers.slice(0, TOP).map((c, i) => (
                  <tr key={c.id}>
                    <td className="faint">{i + 1}</td>
                    <td>
                      <Link to={c.to}>{c.name}</Link>
                    </td>
                    <td className="num">{c.orders}</td>
                    <td className="num mono">{formatCompactMoney(c.revenue)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Panel>

        <Panel title={`Top ${TOP} sales personnel`} blurb={`${data.currentMonth.label} beside ${data.from} to ${data.to}, before VAT`} action={seeAll}>
          {data.people.length === 0 ? (
            <div className="chart-empty">Nobody has booked an order in the range.</div>
          ) : (
            <table className="data">
              <thead>
                <tr>
                  <th>Sales personnel</th>
                  <th>Team</th>
                  <th className="num">{data.currentMonth.label}</th>
                  <th className="num">Range</th>
                </tr>
              </thead>
              <tbody>
                {[...data.people].sort((a, b) => b.range - a.range).slice(0, TOP).map((p) => (
                  <tr key={p.id}>
                    <td>
                      <Link to={p.to}>{p.name}</Link>
                    </td>
                    <td className="faint">{p.team ?? '—'}</td>
                    <td className="num mono">{formatCompactMoney(p.month)}</td>
                    <td className="num mono">{formatCompactMoney(p.range)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Panel>
      </div>
    </>
  );
}
