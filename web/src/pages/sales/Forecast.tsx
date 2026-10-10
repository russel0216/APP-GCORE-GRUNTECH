import { useCallback, useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api, openPdf, qs } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { parseDay } from '../../lib/day';
import { BarList, Panel, Stat } from '../../components/charts';
import { Checkbox, Empty, ErrorBox, Loading, StatusBadge, formatDate, formatMoney, useToast } from '../../components/ui';
import { ExportButton } from '../insights/Overview';
import { STAGE_TONES } from './Quotations';

/*
  The Forecast (2026-10-08, the owner's call): a separate menu after the Sales
  Pipeline — every open quotation by the closing date its salesperson expects,
  consolidated weekly, monthly, quarterly or annually.

  No table of its own: the server reads the open quotations through the
  quotation list's own query (so Mine · Team · All and the visibility rule are
  the list's) and values each by `quotationValue()`, the board's rule. This
  page only draws what `GET /pipeline/forecast` says. The view lives in the
  URL — ?period=&from=&to=&scope=&ownerId=&leads= — so a forecast can be sent
  as a link.
*/

type Period = 'week' | 'month' | 'quarter' | 'year';
const PERIODS: { value: Period; label: string; word: string }[] = [
  { value: 'week', label: 'Weekly', word: 'week' },
  { value: 'month', label: 'Monthly', word: 'month' },
  { value: 'quarter', label: 'Quarterly', word: 'quarter' },
  { value: 'year', label: 'Annually', word: 'year' },
];
const isPeriod = (v: string | null): v is Period => PERIODS.some((p) => p.value === v);

interface Row {
  kind: 'quotation' | 'lead';
  id: string;
  number: string;
  title: string;
  subject: string | null;
  customer: { id: string; name: string } | null;
  owner: { id: string; name: string };
  stage: string;
  stageLabel: string;
  status: string;
  probability: number;
  expectedClosing: string | null;
  value: number;
  weighted: number;
  overdue: boolean;
  link: string;
}

interface Group {
  count: number;
  value: number;
  weighted: number;
  overdue: number;
  rows: Row[];
}

interface Bucket extends Group {
  key: string;
  label: string;
  from: string;
  to: string;
}

interface ForecastData {
  period: Period;
  from: string;
  to: string;
  today: string;
  buckets: Bucket[];
  earlier: Group;
  later: Group;
  undated: Group;
  inWindow: { count: number; value: number; weighted: number; overdue: number };
  totals: { count: number; value: number; weighted: number; overdue: number };
  owners: { id: string; name: string; count: number; value: number; weighted: number }[];
  people: { id: string; name: string }[];
  includeLeads: boolean;
  scope: 'mine' | 'team' | 'all';
  ownerId: string | null;
}

type Scope = 'mine' | 'team' | 'all';

export function Forecast() {
  const { me, can } = useAuth();
  const toast = useToast();
  const [params, setParams] = useSearchParams();
  const [data, setData] = useState<ForecastData | null>(null);
  const [error, setError] = useState<unknown>(null);

  // Mine for whoever may edit quotations, All for a reader — the quotation list's rule.
  const defaultScope: Scope = can('gops.quotations.edit_own') || can('gops.quotations.edit_all') ? 'mine' : 'all';
  const hasTeam = !!me?.user.team;

  const periodParam = params.get('period');
  const period: Period = isPeriod(periodParam) ? periodParam : 'month';
  const from = params.get('from') ?? '';
  const to = params.get('to') ?? '';
  const scopeParam = params.get('scope');
  const scope: Scope = scopeParam === 'mine' || scopeParam === 'all' ? scopeParam : scopeParam === 'team' && hasTeam ? 'team' : defaultScope;
  const ownerId = params.get('ownerId') ?? '';
  const leads = params.get('leads') === 'true';

  const query = qs({
    period,
    from,
    to,
    scope: scope === 'all' ? '' : scope,
    ownerId,
    leads: leads ? 'true' : '',
  });

  /** Writes one or more keys back to the URL (replace, never a history entry); '' or null removes the key. */
  const set = useCallback(
    (patch: Record<string, string | null>) => {
      const next = new URLSearchParams(params);
      for (const [k, v] of Object.entries(patch)) {
        if (v === null || v === '') next.delete(k);
        else next.set(k, v);
      }
      setParams(next, { replace: true });
    },
    [params, setParams],
  );

  const load = useCallback(async () => {
    setError(null);
    try {
      setData(await api.get<ForecastData>(`/pipeline/forecast${query}`));
    } catch (err) {
      setError(err);
    }
  }, [query]);

  useEffect(() => {
    load();
  }, [load]);

  const periodWord = PERIODS.find((p) => p.value === period)!.word;

  return (
    <div className="forecast">
      <div className="page-head">
        <div>
          <h1>Forecast</h1>
        </div>
        <div className="row">
          <div className="scope-switch" role="group" aria-label="Period">
            {PERIODS.map((p) => (
              <button
                key={p.value}
                type="button"
                className={p.value === period ? 'active' : ''}
                aria-pressed={p.value === period}
                // A new period opens on its own default window — twelve weeks, twelve months, eight quarters, three years.
                onClick={() => set({ period: p.value, from: null, to: null })}
              >
                {p.label}
              </button>
            ))}
          </div>
          <div className="scope-switch" role="group" aria-label="Whose quotations">
            {(['mine', ...(hasTeam ? ['team'] : []), 'all'] as Scope[]).map((s) => (
              <button
                key={s}
                type="button"
                className={s === scope ? 'active' : ''}
                aria-pressed={s === scope}
                onClick={() => set({ scope: s === defaultScope ? null : s })}
              >
                {s === 'mine' ? 'Mine' : s === 'team' ? 'Team' : 'All'}
              </button>
            ))}
          </div>
          <ExportButton path={`/pipeline/forecast.csv${query}`} />
          <button
            type="button"
            className="btn"
            onClick={() => openPdf(`/api/pipeline/forecast.pdf${query}`, () => toast('error', 'The PDF could not be opened'))}
          >
            Print
          </button>
        </div>
      </div>

      <div className="row fc-controls">
        <label className="fc-control">
          <span>From</span>
          <input type="date" value={data?.from ?? from} onChange={(e) => set({ from: e.target.value })} />
        </label>
        <label className="fc-control">
          <span>To</span>
          <input type="date" value={data?.to ?? to} onChange={(e) => set({ to: e.target.value })} />
        </label>
        {(from || to) && (
          <button type="button" className="btn btn-sm" onClick={() => set({ from: null, to: null })}>
            Default window
          </button>
        )}
        <label className="fc-control">
          <span>Salesperson</span>
          <select value={ownerId} onChange={(e) => set({ ownerId: e.target.value })}>
            <option value="">Everyone</option>
            {(data?.people ?? []).map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
        <Checkbox checked={leads} onChange={(v) => set({ leads: v ? 'true' : null })} label="Include leads without a quotation" />
      </div>

      {error ? (
        <ErrorBox error={error} />
      ) : !data ? (
        <Loading />
      ) : data.totals.count === 0 ? (
        <Empty
          title="Nothing to forecast"
          hint={`Open quotations${leads ? ' and leads' : ''} appear here under the ${periodWord} their expected closing date falls in. None are open in this view.`}
        />
      ) : (
        <ForecastBody data={data} scope={scope} leads={leads} />
      )}
    </div>
  );
}

function ForecastBody({ data, scope, leads }: { data: ForecastData; scope: Scope; leads: boolean }) {
  const groups: { key: string; label: string; group: Group; from?: string; to?: string }[] = [
    { key: 'earlier', label: `Before ${formatDate(parseDay(data.from))}`, group: data.earlier },
    ...data.buckets.map((b) => ({ key: b.key, label: b.label, group: b, from: b.from, to: b.to })),
    { key: 'later', label: `After ${formatDate(parseDay(data.to))}`, group: data.later },
    { key: 'undated', label: 'No closing date', group: data.undated },
  ];
  const listLink = (fromDay?: string, toDay?: string) =>
    `/g-ops/quotations${qs({ closingFrom: fromDay, closingTo: toDay, scope: scope === 'mine' ? '' : scope })}`;
  const peakWeighted = Math.max(...data.buckets.map((b) => b.weighted), 0);

  return (
    <>
      <div className="grid grid-4 fc-stats">
        <Stat
          label="In the window"
          value={formatMoney(data.inWindow.value)}
          figure
          sub={`${data.inWindow.count} closing ${formatDate(parseDay(data.from))} – ${formatDate(parseDay(data.to))}`}
        />
        <Stat label="Weighted" value={formatMoney(data.inWindow.weighted)} figure tone="neon" sub="at each quotation's own odds" />
        <Stat
          label="Past their closing date"
          value={data.totals.overdue}
          accent={data.totals.overdue > 0 ? 'warn' : undefined}
          sub={data.totals.overdue > 0 ? 'still open — move the date or close them' : 'none'}
        />
        <Stat
          label="Everything open"
          value={formatMoney(data.totals.value)}
          figure
          sub={`${data.totals.count} in this view${data.undated.count ? ` · ${data.undated.count} with no closing date` : ''}`}
        />
      </div>

      <div className="grid grid-2 fc-panels">
        <Panel title="By period">
          <div className="table-wrap">
            <table className="data fc-periods">
              <thead>
                <tr>
                  <th>Period</th>
                  <th className="right">{leads ? 'Deals' : 'Quotations'}</th>
                  <th className="right">Value</th>
                  <th className="right">Weighted</th>
                </tr>
              </thead>
              <tbody>
                {data.buckets.map((b) => (
                  <tr key={b.key} className={b.count === 0 ? 'fc-empty' : ''}>
                    <td className="fc-period">
                      <Link to={listLink(b.from, b.to)}>{b.label}</Link>
                      {b.overdue > 0 && <span className="fc-past"> · {b.overdue} past closing</span>}
                    </td>
                    <td className="right mono">{b.count}</td>
                    <td className="right mono">{b.count ? formatMoney(b.value) : '—'}</td>
                    <td className="right mono">{b.count ? formatMoney(b.weighted) : '—'}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <td className="fc-period">
                    In the window
                    {data.inWindow.overdue > 0 && <span className="fc-past"> · {data.inWindow.overdue} past closing</span>}
                  </td>
                  <td className="right mono">{data.inWindow.count}</td>
                  <td className="right mono">{formatMoney(data.inWindow.value)}</td>
                  <td className="right mono">{formatMoney(data.inWindow.weighted)}</td>
                </tr>
                {(data.earlier.count > 0 || data.later.count > 0 || data.undated.count > 0) && (
                  <tr className="fc-outside">
                    <td className="fc-period">
                      Outside it
                      <span className="faint">
                        {' '}
                        — {[
                          data.earlier.count ? `${data.earlier.count} earlier` : null,
                          data.later.count ? `${data.later.count} later` : null,
                          data.undated.count ? `${data.undated.count} undated` : null,
                        ]
                          .filter(Boolean)
                          .join(', ')}
                      </span>
                    </td>
                    <td className="right mono">{data.totals.count - data.inWindow.count}</td>
                    <td className="right mono">{formatMoney(data.totals.value - data.inWindow.value)}</td>
                    <td className="right mono">{formatMoney(data.totals.weighted - data.inWindow.weighted)}</td>
                  </tr>
                )}
              </tfoot>
            </table>
          </div>
        </Panel>
        <Panel title="Weighted value by period" blurb="Value × probability, the figure to plan against.">
          {peakWeighted > 0 ? (
            <BarList
              slices={data.buckets.map((b) => ({
                label: b.label,
                value: b.weighted,
                display: `${formatMoney(b.weighted)} · ${b.count}`,
                to: listLink(b.from, b.to),
              }))}
            />
          ) : (
            <p className="muted">Nothing closes in this window.</p>
          )}
          {data.owners.length > 1 && (
            <div className="fc-owners">
              <h4>By salesperson</h4>
              <table className="data">
                <thead>
                  <tr>
                    <th>Who</th>
                    <th className="right">{leads ? 'Deals' : 'Quotations'}</th>
                    <th className="right">Value</th>
                    <th className="right">Weighted</th>
                  </tr>
                </thead>
                <tbody>
                  {data.owners.map((o) => (
                    <tr key={o.id}>
                      <td>{o.name}</td>
                      <td className="right mono">{o.count}</td>
                      <td className="right mono">{formatMoney(o.value)}</td>
                      <td className="right mono">{formatMoney(o.weighted)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Panel>
      </div>

      <section className="card fc-list">
        <h3 className="card-title">{leads ? 'Quotations and leads' : 'Quotations'} by expected closing</h3>
        {groups
          .filter(({ group }) => group.count > 0)
          .map(({ key, label, group }) => (
            <div key={key} className="fc-group">
              <h4 className="fc-group-head">
                <span>{label}</span>
                <span className="faint">
                  {group.count} · {formatMoney(group.value)} · weighted {formatMoney(group.weighted)}
                  {group.overdue ? ` · ${group.overdue} past closing` : ''}
                </span>
              </h4>
              <div className="table-wrap">
                <table className="data">
                  <thead>
                    <tr>
                      <th>Number</th>
                      <th>{leads ? 'Deal' : 'Quotation'}</th>
                      <th>Customer</th>
                      <th>Owner</th>
                      <th>Stage</th>
                      <th className="right">Odds</th>
                      <th>Expected closing</th>
                      <th className="right">Value</th>
                      <th className="right">Weighted</th>
                    </tr>
                  </thead>
                  <tbody>
                    {group.rows.map((r) => (
                      <tr key={`${r.kind}-${r.id}`}>
                        <td className="mono">
                          <Link to={r.link}>{r.number}</Link>
                          {r.kind === 'lead' && <span className="faint"> lead</span>}
                        </td>
                        <td>{r.subject ?? <span className="faint">—</span>}</td>
                        <td>{r.title}</td>
                        <td>{r.owner.name}</td>
                        <td>
                          <StatusBadge status={r.stage || r.status} extra={STAGE_TONES} label={r.stageLabel || undefined} />
                        </td>
                        <td className="right mono">{r.probability}%</td>
                        <td className={r.overdue ? 'fc-overdue' : ''}>
                          {r.expectedClosing ? formatDate(parseDay(r.expectedClosing)) : <span className="faint">—</span>}
                          {r.overdue && <span className="fc-past"> past</span>}
                        </td>
                        <td className="right mono">{formatMoney(r.value)}</td>
                        <td className="right mono">{formatMoney(r.weighted)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ))}
      </section>
    </>
  );
}
