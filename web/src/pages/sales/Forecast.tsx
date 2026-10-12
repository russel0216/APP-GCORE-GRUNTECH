import { useCallback, useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api, openPdf, qs } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { parseDay } from '../../lib/day';
import { BarList, MiniBar, Panel, Stat } from '../../components/charts';
import { TickPicker } from '../../components/TickPicker';
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

type Period = 'week' | 'month' | 'quarter' | 'year' | 'range';
const PERIODS: { value: Period; label: string; word: string }[] = [
  { value: 'week', label: 'Weekly', word: 'week' },
  { value: 'month', label: 'Monthly', word: 'month' },
  { value: 'quarter', label: 'Quarterly', word: 'quarter' },
  { value: 'year', label: 'Annually', word: 'year' },
  // The whole window as one period (2026-10-12): a range no calendar period names.
  { value: 'range', label: 'Whole range', word: 'range' },
];

/** The ready-made ranges (2026-10-12); the server resolves each on the Manila day (`rangePreset()`). */
const RANGES: { value: string; label: string }[] = [
  { value: 'this-month', label: 'This month' },
  { value: 'this-quarter', label: 'This quarter' },
  { value: 'this-year', label: 'This year' },
  { value: 'next-30', label: 'Next 30 days' },
  { value: 'next-90', label: 'Next 90 days' },
  { value: 'next-12m', label: 'Next 12 months' },
];

/** The breakdowns (2026-10-12, the owner's call: by salesperson, by product group, by team). */
type By = 'owner' | 'team' | 'group';
const BYS: { value: By; label: string }[] = [
  { value: 'owner', label: 'Salesperson' },
  { value: 'team', label: 'Team' },
  { value: 'group', label: 'Product group' },
];
const isBy = (v: string | null): v is By => BYS.some((b) => b.value === v);

interface Cell {
  count: number;
  value: number;
  weighted: number;
}

interface Line extends Cell {
  id: string;
  name: string;
  hint?: string;
  overdue: number;
  periods: Record<string, Cell>;
  window: Cell;
  earlier: Cell;
  later: Cell;
  undated: Cell;
}
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

/** The comparison (2026-10-12): the period before, the same period last year, or typed days. */
type CompareMode = 'prev-period' | 'prev-year' | 'custom';
const COMPARES: { value: CompareMode; label: string }[] = [
  { value: 'prev-period', label: 'The period before' },
  { value: 'prev-year', label: 'The same period last year' },
  { value: 'custom', label: 'Custom' },
];
const isCompare = (v: string | null): v is CompareMode => COMPARES.some((c) => c.value === v);

interface Change {
  value: number;
  valuePct: number | null;
  weighted: number;
  weightedPct: number | null;
}

interface PrevBucket extends Cell {
  key: string;
  label: string;
  from: string;
  to: string;
}

interface Compare {
  mode: CompareMode;
  label: string;
  from: string;
  to: string;
  pairs: { previous: PrevBucket | null; change: Change | null }[];
  unpaired: PrevBucket[];
  inWindow: { previous: Cell; change: Change };
  lines: Record<By, Record<string, { previous: Cell; change: Change }>>;
}

/** "+12.5%", "−3.0%", "new" (nothing before), "±0" — readable without colour. */
function pctWords(pct: number | null, amount: number): string {
  if (amount === 0) return '±0';
  if (pct === null) return 'new';
  return `${pct > 0 ? '+' : pct < 0 ? '−' : ''}${Math.abs(pct).toFixed(1)}%`;
}

/** A change cell: the amount signed, the percentage under it; a fall in the warn tone. */
function ChangeCell({ change, field = 'weighted' }: { change: Change | null | undefined; field?: 'weighted' | 'value' }) {
  if (!change) return <span className="faint">—</span>;
  const amount = field === 'weighted' ? change.weighted : change.value;
  const pct = field === 'weighted' ? change.weightedPct : change.valuePct;
  return (
    <span className={`fc-cell fc-change${amount < 0 ? ' down' : amount > 0 ? ' up' : ''}`}>
      <span className="fc-cell-main">
        {amount > 0 ? '+' : amount < 0 ? '−' : ''}
        {formatMoney(Math.abs(amount))}
      </span>
      <span className="fc-cell-sub">{pctWords(pct, amount)}</span>
    </span>
  );
}

/** A card's line under its figure: the compared window's figure and the change. */
function compareSub(previous: number, change: { amount: number; pct: number | null }, label: string): string {
  return `${label} ${formatMoney(previous)} · ${pctWords(change.pct, change.amount)}`;
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
  byOwner: Line[];
  byTeam: Line[];
  byGroup: Line[];
  people: { id: string; name: string }[];
  teams: { id: string; code: string; name: string }[];
  groupChoices: { key: string; name: string }[];
  preset: string | null;
  includeLeads: boolean;
  scope: 'mine' | 'team' | 'all';
  compare: Compare | null;
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
  // Several of each (2026-10-12, the owner's tick boxes): comma-separated in the URL; one value reads as before.
  const listParam = (key: string) => (params.get(key) ?? '').split(',').map((v) => v.trim()).filter(Boolean);
  const ownerIds = listParam('ownerId');
  const ownerId = ownerIds.join(',');
  const leads = params.get('leads') === 'true';
  const range = params.get('range') ?? '';
  const teamIds = listParam('teamId');
  const teamId = teamIds.join(',');
  const groupKeys = listParam('group');
  const group = groupKeys.join(',');
  const compareParam = params.get('compare');
  const compare: CompareMode | '' = isCompare(compareParam) ? compareParam : '';
  const compareFrom = params.get('compareFrom') ?? '';
  const compareTo = params.get('compareTo') ?? '';
  // A custom comparison is asked for only once both of its days are typed.
  const compareAsked = compare === 'custom' ? (compareFrom && compareTo ? 'custom' : '') : compare;
  const byParam = params.get('by');
  const by: By = isBy(byParam) ? byParam : 'owner';

  const query = qs({
    period,
    range,
    from: range ? '' : from,
    to: range ? '' : to,
    scope: scope === 'all' ? '' : scope,
    ownerId,
    teamId,
    group,
    leads: leads ? 'true' : '',
    compare: compareAsked,
    compareFrom: compareAsked === 'custom' ? compareFrom : '',
    compareTo: compareAsked === 'custom' ? compareTo : '',
  });
  // The paper prints the breakdown the page shows.
  const paperQuery = qs({
    period,
    range,
    from: range ? '' : from,
    to: range ? '' : to,
    scope: scope === 'all' ? '' : scope,
    ownerId,
    teamId,
    group,
    leads: leads ? 'true' : '',
    compare: compareAsked,
    compareFrom: compareAsked === 'custom' ? compareFrom : '',
    compareTo: compareAsked === 'custom' ? compareTo : '',
    by: by === 'owner' ? '' : by,
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
                // A new period opens on its own default window — twelve weeks, twelve months, eight quarters,
                // three years — unless a range was chosen: the range stays, cut into the new periods.
                onClick={() => set(range || from || to || p.value === 'range' ? { period: p.value } : { period: p.value, from: null, to: null })}
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
            onClick={() => openPdf(`/api/pipeline/forecast.pdf${paperQuery}`, () => toast('error', 'The PDF could not be opened'))}
          >
            Print
          </button>
        </div>
      </div>

      <div className="row fc-controls">
        {/* A specified date range (2026-10-12): a ready-made one, or Custom — typing a date. */}
        <label className="fc-control">
          <span>Range</span>
          <select
            value={range || (from || to ? 'custom' : '')}
            onChange={(e) => {
              const v = e.target.value;
              if (v === 'custom') set({ range: null, from: data?.from ?? from, to: data?.to ?? to });
              else set({ range: v || null, from: null, to: null });
            }}
          >
            <option value="">Default window</option>
            {RANGES.map((r) => (
              <option key={r.value} value={r.value}>
                {r.label}
              </option>
            ))}
            <option value="custom">Custom</option>
          </select>
        </label>
        <label className="fc-control">
          <span>From</span>
          <input
            type="date"
            value={data?.from ?? from}
            onChange={(e) => e.target.value && set({ range: null, from: e.target.value, to: data?.to ?? to })}
          />
        </label>
        <label className="fc-control">
          <span>To</span>
          <input
            type="date"
            value={data?.to ?? to}
            onChange={(e) => e.target.value && set({ range: null, from: data?.from ?? from, to: e.target.value })}
          />
        </label>
        <div className="fc-control">
          <span>Salesperson</span>
          <TickPicker
            label="Salespeople"
            noun="salespeople"
            none="Everyone"
            choices={(data?.people ?? []).map((p) => ({ value: p.id, label: p.name }))}
            value={ownerIds}
            onChange={(v) => set({ ownerId: v.join(',') })}
          />
        </div>
        <div className="fc-control">
          <span>Team</span>
          <TickPicker
            label="Teams"
            noun="teams"
            none="Every team"
            choices={[
              ...(data?.teams ?? []).map((t) => ({ value: t.id, label: t.code, hint: t.name })),
              { value: 'none', label: 'No team' },
            ]}
            value={teamIds}
            onChange={(v) => set({ teamId: v.join(',') })}
          />
        </div>
        <div className="fc-control">
          <span>Product group</span>
          <TickPicker
            label="Product groups"
            noun="product groups"
            none="Every group"
            choices={[...(data?.groupChoices ?? []).map((g) => ({ value: g.key, label: g.name })), { value: 'none', label: 'No group' }]}
            value={groupKeys}
            onChange={(v) => set({ group: v.join(',') })}
          />
        </div>
        {/* The comparison (2026-10-12): a second window beside the first. */}
        <label className="fc-control">
          <span>Compare with</span>
          <select
            value={compare}
            onChange={(e) => {
              const v = e.target.value;
              set({ compare: v || null, ...(v === 'custom' ? {} : { compareFrom: null, compareTo: null }) });
            }}
          >
            <option value="">Nothing</option>
            {COMPARES.map((c) => (
              <option key={c.value} value={c.value}>
                {c.label}
              </option>
            ))}
          </select>
        </label>
        {compare === 'custom' && (
          <>
            <label className="fc-control">
              <span>Compare from</span>
              <input type="date" value={compareFrom} onChange={(e) => set({ compareFrom: e.target.value || null })} />
            </label>
            <label className="fc-control">
              <span>Compare to</span>
              <input type="date" value={compareTo} onChange={(e) => set({ compareTo: e.target.value || null })} />
            </label>
          </>
        )}
        <Checkbox checked={leads} onChange={(v) => set({ leads: v ? 'true' : null })} label="Include leads without a quotation" />
      </div>

      {error ? (
        <ErrorBox error={error} />
      ) : !data ? (
        <Loading />
      ) : data.totals.count === 0 && !data.compare?.inWindow.previous.count ? (
        <Empty
          title="Nothing to forecast"
          hint={`Open quotations${leads ? ' and leads' : ''} appear here under the ${periodWord} their expected closing date falls in. None are open in this view.`}
        />
      ) : (
        <ForecastBody data={data} scope={scope} leads={leads} by={by} onBy={(b) => set({ by: b === 'owner' ? null : b })} grouped={!!group} />
      )}
    </div>
  );
}

function ForecastBody({
  data,
  scope,
  leads,
  by,
  onBy,
  grouped,
}: {
  data: ForecastData;
  scope: Scope;
  leads: boolean;
  by: By;
  onBy: (b: By) => void;
  /** A product group is chosen: every figure is that group's share. */
  grouped: boolean;
}) {
  const groups: { key: string; label: string; group: Group; from?: string; to?: string }[] = [
    { key: 'earlier', label: `Before ${formatDate(parseDay(data.from))}`, group: data.earlier },
    ...data.buckets.map((b) => ({ key: b.key, label: b.label, group: b, from: b.from, to: b.to })),
    { key: 'later', label: `After ${formatDate(parseDay(data.to))}`, group: data.later },
    { key: 'undated', label: 'No closing date', group: data.undated },
  ];
  const listLink = (fromDay?: string, toDay?: string) =>
    `/g-ops/quotations${qs({ closingFrom: fromDay, closingTo: toDay, scope: scope === 'mine' ? '' : scope })}`;
  const peakWeighted = Math.max(...data.buckets.map((b) => b.weighted), ...(data.compare?.pairs.map((p) => p.previous?.weighted ?? 0) ?? []), 0);
  const cmp = data.compare;
  const prevWord = cmp ? (cmp.mode === 'prev-year' ? 'last year' : cmp.mode === 'prev-period' ? 'before' : 'compared') : '';
  const cols = 5 + (cmp ? 2 : 0);

  return (
    <>
      <div className="grid grid-4 fc-stats">
        <Stat
          label="In the window"
          value={formatMoney(data.inWindow.value)}
          figure
          sub={
            cmp
              ? compareSub(cmp.inWindow.previous.value, { amount: cmp.inWindow.change.value, pct: cmp.inWindow.change.valuePct }, prevWord)
              : `${data.inWindow.count} closing ${formatDate(parseDay(data.from))} – ${formatDate(parseDay(data.to))}`
          }
        />
        <Stat
          label="Weighted"
          value={formatMoney(data.inWindow.weighted)}
          figure
          tone="neon"
          sub={
            cmp
              ? compareSub(cmp.inWindow.previous.weighted, { amount: cmp.inWindow.change.weighted, pct: cmp.inWindow.change.weightedPct }, prevWord)
              : "at each quotation's own odds"
          }
        />
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

      {cmp && (
        <p className="muted fc-compare-note">
          Comparing {formatDate(parseDay(data.from))} – {formatDate(parseDay(data.to))} with {cmp.label.toLowerCase()},{' '}
          {formatDate(parseDay(cmp.from))} – {formatDate(parseDay(cmp.to))}. Both windows count won quotations in full and lost ones at
          nothing (by the day they were decided), and open ones at their odds, so the two are read alike.
        </p>
      )}

      {/* By period takes the whole width (2026-10-12): its Weighted column carries the bar, so nothing is cut off. */}
      <div className="fc-panels">
      <Panel title={cmp ? `By period — against ${cmp.label.toLowerCase()}` : 'By period'}>
        <div className="table-wrap">
          <table className="data fc-periods">
            <thead>
              <tr>
                <th>Period</th>
                <th className="right">{leads ? 'Deals' : 'Quotations'}</th>
                <th className="right">Value</th>
                <th className="right">Weighted</th>
                <th className="fc-bar-col" aria-label="Weighted, as a bar" />
                {cmp && <th className="right">Previous</th>}
                {cmp && <th className="right">Change</th>}
              </tr>
            </thead>
            <tbody>
              {data.buckets.map((b, i) => {
                const pair = cmp?.pairs[i];
                return (
                  <tr key={b.key} className={b.count === 0 && !pair?.previous?.count ? 'fc-empty' : ''}>
                    <td className="fc-period">
                      <Link to={listLink(b.from, b.to)}>{b.label}</Link>
                      {b.overdue > 0 && <span className="fc-past"> · {b.overdue} past closing</span>}
                      {pair?.previous && <span className="fc-cell-sub">vs {pair.previous.label}</span>}
                    </td>
                    <td className="right mono">{b.count}</td>
                    <td className="right mono">{b.count ? formatMoney(b.value) : '—'}</td>
                    <td className="right mono">{b.count ? formatMoney(b.weighted) : '—'}</td>
                    <td className="fc-bar-col">
                      <MiniBar value={b.weighted} peak={peakWeighted} />
                    </td>
                    {cmp && (
                      <td className="right mono">
                        {pair?.previous ? (
                          pair.previous.count ? (
                            <span className="fc-cell">
                              <span className="fc-cell-main">{formatMoney(pair.previous.weighted)}</span>
                              <span className="fc-cell-sub">
                                {pair.previous.count} · {formatMoney(pair.previous.value)}
                              </span>
                            </span>
                          ) : (
                            <span className="faint">—</span>
                          )
                        ) : (
                          <span className="faint">—</span>
                        )}
                      </td>
                    )}
                    {cmp && (
                      <td className="right mono">
                        <ChangeCell change={pair?.change} />
                      </td>
                    )}
                  </tr>
                );
              })}
              {cmp?.unpaired.map((p) => (
                <tr key={`prev-${p.key}`} className="fc-empty">
                  <td className="fc-period">
                    <span className="faint">—</span>
                    <span className="fc-cell-sub">vs {p.label}</span>
                  </td>
                  <td className="right mono" colSpan={4} />
                  <td className="right mono">{p.count ? formatMoney(p.weighted) : '—'}</td>
                  <td className="right mono">
                    <span className="faint">—</span>
                  </td>
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
                <td className="fc-bar-col" />
                {cmp && (
                  <td className="right mono">
                    <span className="fc-cell">
                      <span className="fc-cell-main">{formatMoney(cmp.inWindow.previous.weighted)}</span>
                      <span className="fc-cell-sub">
                        {cmp.inWindow.previous.count} · {formatMoney(cmp.inWindow.previous.value)}
                      </span>
                    </span>
                  </td>
                )}
                {cmp && (
                  <td className="right mono">
                    <ChangeCell change={cmp.inWindow.change} />
                  </td>
                )}
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
                  <td colSpan={cols - 4} />
                </tr>
              )}
            </tfoot>
          </table>
        </div>
      </Panel>
      </div>

      <Breakdown data={data} by={by} onBy={onBy} scope={scope} leads={leads} grouped={grouped} />

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

/**
 * The breakdown (2026-10-12, the owner's call: "forecast of sales person, by
 * product group, by team"): one row per salesperson, team or product group,
 * its weighted figure in each period of the window (the value small under
 * it), then before / after / no date and the total; the foot is the
 * forecast's own figures, which the lines add up to. A product group's row
 * is its share of each quotation, split by line amount.
 */
function Breakdown({
  data,
  by,
  onBy,
  scope,
  leads,
  grouped,
}: {
  data: ForecastData;
  by: By;
  onBy: (b: By) => void;
  scope: Scope;
  leads: boolean;
  grouped: boolean;
}) {
  const lines = by === 'owner' ? data.byOwner : by === 'team' ? data.byTeam : data.byGroup;
  const word = BYS.find((b) => b.value === by)!.label;
  // With a comparison each line's window stands beside the compared window's (2026-10-12).
  const cmp = data.compare;
  const compared = (id: string) => cmp?.lines[by][id];
  // A salesperson's figures open the quotation list on that person (and that period's closing dates).
  const ownerLink = (id: string, fromDay?: string, toDay?: string) =>
    `/g-ops/quotations${qs({ ownerId: id, closingFrom: fromDay, closingTo: toDay, scope: scope === 'mine' ? '' : scope })}`;
  const cell = (c: Cell | undefined, link?: string) => {
    if (!c || c.count === 0) return <span className="faint">—</span>;
    const figure = (
      <>
        <span className="fc-cell-main">{formatMoney(c.weighted)}</span>
        <span className="fc-cell-sub">{formatMoney(c.value)}</span>
      </>
    );
    return link ? <Link to={link} className="fc-cell">{figure}</Link> : <span className="fc-cell">{figure}</span>;
  };
  const foot = (c: Cell) => cell(c);
  const peak = Math.max(...lines.map((l) => l.weighted), 0);
  return (
    <section className="card fc-breakdown">
      <div className="row fc-breakdown-head">
        <h3 className="card-title">By {word.toLowerCase()}</h3>
        <div className="scope-switch" role="group" aria-label="Break the forecast down by">
          {BYS.map((b) => (
            <button key={b.value} type="button" className={b.value === by ? 'active' : ''} aria-pressed={b.value === by} onClick={() => onBy(b.value)}>
              {b.label}
            </button>
          ))}
        </div>
      </div>
      <p className="muted fc-breakdown-note">
        Weighted (value × odds) in each period, the full value under it.
        {by === 'group' && !grouped && ' A quotation is split across its product groups by its line amounts, so it may count under more than one.'}
        {by === 'team' && " A quotation counts under the team it was tagged with, else its author's."}
        {cmp && ` "Previous" is each line's window ${cmp.label.toLowerCase()} (${formatDate(parseDay(cmp.from))} – ${formatDate(parseDay(cmp.to))}); the change is weighted.`}
      </p>
      {lines.length === 0 ? (
        <p className="muted">Nothing in this view.</p>
      ) : (
        <>
          {peak > 0 && lines.length > 1 && (
            <BarList
              slices={lines.map((l) => ({
                label: l.hint ? `${l.name} — ${l.hint}` : l.name,
                value: l.weighted,
                display: `${formatMoney(l.weighted)} · ${l.count}`,
                to: by === 'owner' ? ownerLink(l.id) : undefined,
              }))}
            />
          )}
          <div className="table-wrap fc-matrix-wrap">
            <table className="data fc-matrix">
              <thead>
                <tr>
                  <th>{word}</th>
                  <th className="right">{by === 'group' || !leads ? 'Quotations' : 'Deals'}</th>
                  {cmp && <th className="right">In the window</th>}
                  {cmp && <th className="right">Previous</th>}
                  {cmp && <th className="right">Change</th>}
                  {data.buckets.map((b) => (
                    <th key={b.key} className="right">
                      {b.label}
                    </th>
                  ))}
                  <th className="right">Before</th>
                  <th className="right">After</th>
                  <th className="right">No date</th>
                  <th className="right">Total</th>
                </tr>
              </thead>
              <tbody>
                {lines.map((l) => (
                  <tr key={l.id || 'none'}>
                    <td className="fc-matrix-name">
                      {by === 'owner' ? <Link to={ownerLink(l.id)}>{l.name}</Link> : l.name}
                      {l.hint && <span className="fc-cell-sub">{l.hint}</span>}
                      {l.overdue > 0 && <span className="fc-past"> · {l.overdue} past closing</span>}
                    </td>
                    <td className="right mono">{l.count}</td>
                    {cmp && <td className="right mono fc-matrix-total">{cell(l.window)}</td>}
                    {cmp && <td className="right mono">{cell(compared(l.id)?.previous)}</td>}
                    {cmp && (
                      <td className="right mono">
                        <ChangeCell change={compared(l.id)?.change} />
                      </td>
                    )}
                    {data.buckets.map((b) => (
                      <td key={b.key} className="right mono">
                        {cell(l.periods[b.key], by === 'owner' ? ownerLink(l.id, b.from, b.to) : undefined)}
                      </td>
                    ))}
                    <td className="right mono">{cell(l.earlier)}</td>
                    <td className="right mono">{cell(l.later)}</td>
                    <td className="right mono">{cell(l.undated)}</td>
                    <td className="right mono fc-matrix-total">{cell(l)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <td className="fc-matrix-name">Everything in view</td>
                  <td className="right mono">{data.totals.count}</td>
                  {cmp && <td className="right mono fc-matrix-total">{foot(data.inWindow)}</td>}
                  {cmp && <td className="right mono">{foot(cmp.inWindow.previous)}</td>}
                  {cmp && (
                    <td className="right mono">
                      <ChangeCell change={cmp.inWindow.change} />
                    </td>
                  )}
                  {data.buckets.map((b) => (
                    <td key={b.key} className="right mono">
                      {foot(b)}
                    </td>
                  ))}
                  <td className="right mono">{foot(data.earlier)}</td>
                  <td className="right mono">{foot(data.later)}</td>
                  <td className="right mono">{foot(data.undated)}</td>
                  <td className="right mono fc-matrix-total">{foot(data.totals)}</td>
                </tr>
              </tfoot>
            </table>
          </div>
        </>
      )}
    </section>
  );
}
