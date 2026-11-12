import type { ReactNode } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { IconBadge, type IconName } from './Icon';
import { layoutSankey, type SankeyInput } from '../lib/sankey';

/**
 * The chart set.
 *
 * Hand-rolled SVG and CSS, no charting library — the same reason the rest of
 * this app has no UI framework, and these are a handful of shapes rather than
 * forty. `Brief` — a chart of sentences — is the newest.
 *
 * Three near-identical bars already existed before this file: `ProgressBar`
 * with `.meter` in Projects, `Bar` with `.mini-bar` in Insights, and
 * `.flow-bars` in the cash-flow card. They looked different on every screen
 * because nobody had decided what a bar looked like. This is that decision.
 *
 * Two rules these follow, which the ad-hoc versions did not:
 *
 *  - **A chart is readable without colour.** Every series is labelled and
 *    carries its own number. Colour ranks things; it never carries the only
 *    copy of a fact, because roughly one man in twelve cannot separate the
 *    neon from the amber.
 *  - **A chart says what it is measuring, or it is wallpaper.** Every one of
 *    these takes a caption, and an empty series says "nothing yet" rather than
 *    drawing an empty frame that looks like a loading failure.
 */

export type Tone = 'neon' | 'magenta' | 'warn' | 'danger' | 'info' | 'muted';

const TONE_VAR: Record<Tone, string> = {
  neon: 'var(--neon)',
  magenta: 'var(--magenta)',
  warn: 'var(--warn)',
  danger: 'var(--danger)',
  info: 'var(--info)',
  muted: 'var(--faint)',
};

export interface Slice {
  label: string;
  /** Drives the geometry: bar length, funnel width, donut arc. */
  value: number;
  /**
   * What to PRINT, when the raw number is not what a reader wants to see.
   *
   * A bar of money is the case that forces this: `value` has to stay a number
   * for the maths, but printing it raw gives "335386.66" beside a bar. Pass
   * `formatMoney(...)` here and the geometry is unaffected.
   */
  display?: string;
  tone?: Tone;
  /** The list this slice counted — a figure you cannot open is a dead end. */
  to?: string;
}

// ── Stat ─────────────────────────────────────────────────────────────────────

/**
 * The KPI card: one number, what it means, and what it implies.
 *
 *   ORDERS AWAITING DELIVERY
 *   14
 *   3 of them overdue
 *
 * There were three of these before this one. `Stat` here, `Tile` in Insights
 * (32 call sites, and a `<div onClick>` no keyboard could reach), and hand-
 * written markup in the HR, G-CHAIN and Aftermarket dashboards. Same card,
 * four appearances.
 *
 * `accent` paints the left edge and the figure. It is for "this one needs
 * attention", and it only ever ADDS to what the card already says in words —
 * `sub` carries the same meaning in text, because roughly one man in twelve
 * cannot separate the neon from the amber.
 *
 * `value` is a ReactNode: some cards show a Meter or a formatted money string
 * rather than a bare number. Pass `figure` for anything long or comma'd —
 * Orbitron is a display face and has no useful comma.
 */
export function Stat({
  label,
  value,
  hint,
  sub,
  tone,
  accent,
  figure,
  icon,
  more,
  to,
}: {
  label: string;
  value: ReactNode;
  /** Context under the figure. `sub` is the Insights name for the same slot. */
  hint?: ReactNode;
  sub?: ReactNode;
  /** Palette name, or a raw colour for the few series that need one. */
  tone?: Tone | string;
  /** Left edge + figure colour. Applied whatever the value. */
  accent?: 'ok' | 'warn' | 'danger' | 'info' | 'neon' | 'quiet';
  /** Set the figure in Inter rather than Orbitron — for money and long numbers. */
  figure?: boolean;
  /** A badged disc above the label. */
  icon?: IconName;
  /**
   * The "View details ›" footer. Only meaningful with `to`: a tile that is
   * secretly a link is a tile most people never click.
   */
  more?: string;
  to?: string;
}) {
  const context = hint ?? sub;
  const colour = tone ? (TONE_VAR[tone as Tone] ?? tone) : undefined;

  const body = (
    <>
      {icon && <IconBadge name={icon} accent={accent ?? 'neon'} />}
      <div className="kpi-label">{label}</div>
      <div
        className={`kpi-value${figure ? ' figure' : ''}`}
        style={colour ? { color: colour } : undefined}
      >
        {value === null || value === undefined ? '—' : value}
      </div>
      {context !== undefined && context !== null && <div className="kpi-subtext">{context}</div>}
      {to && more && (
        <span className="kpi-more">
          {more}
          <span className="chev" aria-hidden="true">
            ›
          </span>
        </span>
      )}
    </>
  );

  // .kpi-card is self-contained — it carries its own surface, radius and
  // hover, so it is not composed onto .card.
  const className = `kpi-card${accent ? ` ${accent}` : ''}${icon || more ? ' badged' : ''}`;

  // A Link, never a div with an onClick. Thirty-two of these were unreachable
  // by keyboard before they came through here.
  return to ? (
    <Link to={to} className={className}>
      {body}
    </Link>
  ) : (
    <div className={className}>{body}</div>
  );
}

// ── Bars ─────────────────────────────────────────────────────────────────────

/**
 * A labelled horizontal bar per row, scaled to the largest.
 *
 * Horizontal rather than vertical because the labels are words — "Quotation
 * submitted", "Site visit" — and words read along a bar and not under one.
 */
export function BarList({
  slices,
  caption,
  total,
}: {
  slices: Slice[];
  caption?: string;
  /** Scale against this instead of the largest slice, to show share of a whole. */
  total?: number;
}) {
  const peak = total ?? Math.max(...slices.map((s) => s.value), 0);
  const sum = slices.reduce((a, s) => a + s.value, 0);

  if (sum === 0) {
    return <Empty caption={caption} />;
  }

  return (
    <div className="chart">
      {caption && <div className="chart-caption">{caption}</div>}
      <div className="bar-list">
        {slices.map((s) => {
          const row = (
            <>
              <span className="bar-label">{s.label}</span>
              <span className="bar-track">
                <span
                  className="bar-fill"
                  style={{
                    width: peak > 0 ? `${Math.max(s.value > 0 ? 2 : 0, (s.value / peak) * 100)}%` : 0,
                    background: TONE_VAR[s.tone ?? 'neon'],
                  }}
                />
              </span>
              <span className="bar-value">{s.display ?? s.value}</span>
            </>
          );
          return s.to ? (
            <Link key={s.label} to={s.to} className="bar-row">
              {row}
            </Link>
          ) : (
            <div key={s.label} className="bar-row">
              {row}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── Funnel ───────────────────────────────────────────────────────────────────

/**
 * The pipeline, stage by stage.
 *
 * This is the one chart on the operations dashboard that is genuinely a shape
 * rather than a list: what you are looking for is the step where the width
 * collapses, because that is where work is being lost. The drop-off is printed
 * beside each stage so the shape is not the only copy of it.
 */
export function Funnel({ stages, caption }: { stages: Slice[]; caption?: string }) {
  // Scaled to the widest stage, not the first. Scaling to the first is the
  // textbook funnel and it degenerates twice here: to nothing when the top of
  // the pipeline is empty, and to an overflowing bar whenever a later stage is
  // larger — which happens constantly, because "won" accumulates while
  // "enquiries in play" is only ever what is open right now.
  const peak = Math.max(...stages.map((x) => x.value), 0);
  if (peak === 0) return <Empty caption={caption} />;

  return (
    <div className="chart">
      {caption && <div className="chart-caption">{caption}</div>}
      <div className="funnel">
        {stages.map((stage, i) => {
          const share = stage.value / peak;
          const previous = i > 0 ? stages[i - 1].value : null;
          const drop =
            previous && previous > 0 && stage.value < previous
              ? `−${Math.round(((previous - stage.value) / previous) * 100)}%`
              : null;
          const body = (
            <>
              <span className="funnel-label">{stage.label}</span>
              <span className="funnel-track">
                <span
                  className="funnel-fill"
                  style={{
                    width: `${Math.max(stage.value > 0 ? 4 : 0, share * 100)}%`,
                    background: TONE_VAR[stage.tone ?? 'neon'],
                  }}
                />
              </span>
              <span className="funnel-value">{stage.display ?? stage.value}</span>
              <span className="funnel-drop">{drop ?? ''}</span>
            </>
          );
          return stage.to ? (
            <Link key={stage.label} to={stage.to} className="funnel-row">
              {body}
            </Link>
          ) : (
            <div key={stage.label} className="funnel-row">
              {body}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── Donut ────────────────────────────────────────────────────────────────────

/**
 * Share of a whole, with the whole in the middle.
 *
 * Only for things that genuinely are parts of one total — a job is in exactly
 * one status, so the statuses make a whole. Never for unrelated counts side by
 * side, which is the usual way a doughnut ends up lying.
 */
export function Donut({
  slices,
  caption,
  centreLabel,
  centreValue,
}: {
  slices: Slice[];
  caption?: string;
  centreLabel?: string;
  /** Overrides the summed total in the middle — for money, same reason as `display`. */
  centreValue?: string;
}) {
  const total = slices.reduce((a, s) => a + s.value, 0);
  if (total === 0) return <Empty caption={caption} />;

  const R = 54;
  const C = 2 * Math.PI * R;
  let offset = 0;

  return (
    <div className="chart">
      {caption && <div className="chart-caption">{caption}</div>}
      <div className="donut">
        <svg viewBox="0 0 140 140" role="img" aria-label={caption ?? 'Breakdown'}>
          <circle cx="70" cy="70" r={R} className="donut-track" />
          {slices
            .filter((s) => s.value > 0)
            .map((s) => {
              const len = (s.value / total) * C;
              const dash = `${len} ${C - len}`;
              // -90deg so the first slice starts at twelve o'clock, which is
              // where the eye starts.
              const el = (
                <circle
                  key={s.label}
                  cx="70"
                  cy="70"
                  r={R}
                  className="donut-slice"
                  stroke={TONE_VAR[s.tone ?? 'neon']}
                  strokeDasharray={dash}
                  strokeDashoffset={-offset}
                  transform="rotate(-90 70 70)"
                >
                  <title>{`${s.label}: ${s.display ?? s.value}`}</title>
                </circle>
              );
              offset += len;
              return el;
            })}
          {/* A money total is far wider than a count. It drops a size rather
              than overflowing the ring. */}
          <text
            x="70"
            y="66"
            className={`donut-total${centreValue && centreValue.length > 6 ? ' long' : ''}`}
          >
            {centreValue ?? total}
          </text>
          {centreLabel && (
            <text x="70" y="82" className="donut-caption">
              {centreLabel}
            </text>
          )}
        </svg>

        {/* The legend is the chart. The ring only ranks what the legend says. */}
        <ul className="donut-legend">
          {slices.map((s) => (
            <li key={s.label}>
              <span className="swatch" style={{ background: TONE_VAR[s.tone ?? 'neon'] }} />
              {s.to ? <Link to={s.to}>{s.label}</Link> : <span>{s.label}</span>}
              <strong>{s.display ?? s.value}</strong>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

/**
 * A bare bar with no label of its own, for use inside a table cell where the
 * row already says what it is. Kept separate from BarList because that one
 * brings its own labels and would fight the table's.
 *
 * `tone` here is a raw colour rather than the palette name: the Insights
 * screens pass an rgba() per series to distinguish billed from collected on
 * the same row, which the six named tones cannot express.
 */
export function MiniBar({ value, peak, tone }: { value: number; peak: number; tone?: string }) {
  return (
    <div className="mini-bar">
      <div
        className="mini-bar-fill"
        style={{
          width: `${peak > 0 ? Math.max(1, (Math.abs(value) / peak) * 100) : 0}%`,
          background: tone,
        }}
      />
    </div>
  );
}

// ── Meter ────────────────────────────────────────────────────────────────────

/**
 * A single percentage with the number printed on it.
 *
 * Exported as `ProgressBar` from delivery/Projects as well, which is the name
 * eight call sites already use. One implementation, two names, rather than the
 * two implementations there were.
 */
export function Meter({ pct, tone }: { pct: number; tone?: string }) {
  const clamped = Math.max(0, Math.min(100, pct));
  return (
    <div className="meter" title={`${pct.toFixed(1)}%`}>
      <div className={`meter-fill${tone ? ` ${tone}` : ''}`} style={{ width: `${clamped}%` }} />
      <span className="meter-label mono">{pct.toFixed(1)}%</span>
    </div>
  );
}

// ── Brief ────────────────────────────────────────────────────────────────────

/** A run of words, or a figure. A figure with `to` opens the list it counted. */
export interface BriefPart {
  text?: string;
  value?: string;
  to?: string;
  tone?: Tone;
  /** What the figure is, for a screen reader and the hover title — "Receivable overdue". */
  label?: string;
}

/** One sentence-with-figures, tagged with the division it describes. */
export interface BriefLine {
  key: string;
  tag: string;
  /** The division's own dashboard — the tag links there. */
  to: string;
  tone?: Tone;
  /** A quieter second line: when the figures were read, or whose they are. */
  hint?: string;
  parts: BriefPart[];
}

/**
 * A chart of sentences.
 *
 *   G-FIN   Customers owe PHP 1,562,200.00 (PHP 90,000.00 overdue); …
 *
 * Belongs here with the other shapes because it follows their two rules: the
 * words carry the meaning and colour only adds to them (a figure is toned
 * only when it is non-zero and worth a look), and an empty brief says
 * "nothing yet". Every tag and every figure is a `<Link>`, so the whole brief
 * is reachable from a keyboard and each number opens the list behind it.
 */
export function Brief({ lines, caption }: { lines: BriefLine[]; caption?: string }) {
  const shown = lines.filter((l) => l.parts.some((p) => p.value !== undefined));
  if (shown.length === 0) return <Empty caption={caption} />;

  return (
    <div className="chart">
      {caption && <div className="chart-caption">{caption}</div>}
      <ul className="brief">
        {shown.map((l) => (
          <li key={l.key} className="brief-row">
            <Link
              to={l.to}
              className="brief-tag"
              style={l.tone ? { color: TONE_VAR[l.tone] } : undefined}
            >
              {l.tag}
            </Link>
            <div>
              <p className="brief-text">
                {l.parts.map((p, i) => {
                  if (p.value === undefined) return <span key={i}>{p.text}</span>;
                  const style = p.tone ? { color: TONE_VAR[p.tone] } : undefined;
                  const name = p.label ? `${p.label}: ${p.value}` : undefined;
                  return p.to ? (
                    <Link key={i} to={p.to} className="brief-figure" style={style} title={p.label} aria-label={name}>
                      {p.value}
                    </Link>
                  ) : (
                    <strong key={i} className="brief-figure" style={style} title={p.label}>
                      {p.value}
                    </strong>
                  );
                })}
              </p>
              {l.hint && <span className="brief-hint">{l.hint}</span>}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

// ── Grouped bars ─────────────────────────────────────────────────────────────

/** One group of bars — a month — with a value per series. */
export interface BarGroup {
  label: string;
  values: number[];
  /** A mark after the label ("*" for a month still running) with its meaning. */
  mark?: string;
  note?: string;
  /** Drawn fainter: a month not yet over, a forecast. */
  faint?: boolean;
}

/**
 * Vertical bars, a group per period and a bar per series inside it — this
 * year against last, month by month (2026-11-08, the owner's G-OPS
 * dashboard). The ONE vertical chart in the set: the labels are months,
 * three letters that sit under a bar. Every bar prints its own figure, so
 * the two series are told apart by the legend and the numbers, never by
 * colour alone; an empty chart says so.
 */
export function GroupedBars({
  groups,
  series,
  format,
  caption,
}: {
  groups: BarGroup[];
  series: { label: string; tone: Tone | string }[];
  format: (v: number) => string;
  caption?: string;
}) {
  const peak = Math.max(0, ...groups.flatMap((g) => g.values));
  if (peak === 0) return <Empty caption={caption} />;
  const W = 1200;
  const H = 300;
  const padL = 56;
  const padB = 28;
  const padT = 22;
  const plotW = W - padL - 8;
  const plotH = H - padT - padB;
  const groupW = plotW / groups.length;
  const barW = Math.min(26, (groupW - 10) / series.length);
  const inner = barW * series.length;
  const y = (v: number) => padT + plotH - (v / peak) * plotH;
  // Four gridlines at round figures.
  const step = niceStep(peak / 4);
  const ticks: number[] = [];
  for (let t = step; t <= peak * 1.001 && ticks.length < 8; t += step) ticks.push(t);
  const colour = (t: Tone | string) => TONE_VAR[t as Tone] ?? t;
  return (
    <div className="chart">
      {caption && <div className="chart-caption">{caption}</div>}
      <ul className="gbar-legend">
        {series.map((s) => (
          <li key={s.label}>
            <span className="swatch" style={{ background: colour(s.tone) }} />
            {s.label}
          </li>
        ))}
      </ul>
      <svg viewBox={`0 0 ${W} ${H}`} className="gbar" role="img" aria-label={caption ?? 'Bars'}>
        {ticks.map((t) => (
          <g key={t}>
            <line x1={padL} x2={W - 8} y1={y(t)} y2={y(t)} className="gbar-grid" />
            <text x={padL - 6} y={y(t) + 3} className="gbar-tick">
              {format(t)}
            </text>
          </g>
        ))}
        {groups.map((g, gi) => {
          const x0 = padL + gi * groupW + (groupW - inner) / 2;
          return (
            <g key={g.label} className={g.faint ? 'is-faint' : undefined}>
              {g.values.map((v, si) => {
                const x = x0 + si * barW;
                const top = y(v);
                return (
                  <g key={si}>
                    <rect x={x + 1} y={top} width={barW - 2} height={Math.max(0, padT + plotH - top)} rx={3} fill={colour(series[si].tone)} className="gbar-bar">
                      <title>{`${g.label}${g.mark ?? ''} · ${series[si].label}: ${format(v)}`}</title>
                    </rect>
                    {v > 0 && (
                      <text x={x + barW / 2} y={top - 4} className="gbar-value">
                        {format(v)}
                      </text>
                    )}
                  </g>
                );
              })}
              <text x={x0 + inner / 2} y={H - 8} className="gbar-label">
                {g.label}
                {g.mark ?? ''}
              </text>
            </g>
          );
        })}
      </svg>
      {groups.some((g) => g.note) && <div className="chart-note">{[...new Set(groups.map((g) => g.note).filter(Boolean))].join(' · ')}</div>}
    </div>
  );
}

function niceStep(raw: number): number {
  if (raw <= 0) return 1;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const n = raw / mag;
  const step = n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10;
  return step * mag;
}

// ── Sankey ───────────────────────────────────────────────────────────────────

/**
 * The flow of a whole through its parts — Gruntech → team → person
 * (2026-11-08, the owner's call). The geometry is `lib/sankey.ts`, pure and
 * pinned; this draws it: a band per flow, a bar per node, and beside every
 * node its name, its figure and its share of the root, so the picture is
 * readable without colour and the Sankey's one claim — the parts add up to
 * the whole — can be checked by eye. A team or a person opens the list it
 * counted.
 */
export function Sankey({ input, format, caption, oneLine }: { input: SankeyInput; format: (v: number) => string; caption?: string; oneLine?: boolean }) {
  const W = 1080;
  // Two lines of label per node (the name, then the figure and share), so
  // every node needs about 40 units of height whatever its value; a margin
  // top and bottom keeps the end nodes' labels on the canvas.
  const rows = Math.max(input.teams.filter((t) => t.value > 0).length, input.people.filter((p) => p.value > 0).length, 1);
  // Room above and below for half a label, so the end nodes' names fit.
  const pad = 28;
  // Every node is given at least two lines of label (PITCH), so each name
  // sits beside its own bar (2026-11-10, the owner's report); the canvas
  // grows with the people so the large nodes keep room of their own.
  // `oneLine` (2026-11-12, the owner's call for the customer flow: "customer
  // name, the value and percent in one line") gives the last column one line
  // of label a node, so a hundred customers fit without one name on another.
  const PITCH = oneLine ? 20 : 44;
  const teamRows = Math.max(input.teams.filter((t) => t.value > 0).length, 1);
  const H = oneLine ? Math.max(360, 64 * teamRows + pad * 2, 26 * rows + pad * 2) : Math.max(360, 64 * rows + pad * 2);
  // Only Gruntech's label sits left of the flow and only the people's right
  // of it (2026-11-09, the owner's call: "widen, maximizing the left and
  // right space"), so each side keeps just the room its own labels need.
  const labelW = 130;
  const labelR = oneLine ? 400 : 190;
  const lay = layoutSankey(input, { width: W - labelW - labelR, height: H - pad * 2, nodeWidth: 14, gap: oneLine ? 6 : 22, pitch: PITCH });
  // One line holds the name, the figure and the share: a long name is cut
  // so the figures always fit (the whole name is the node's tooltip).
  const NAME_MAX = 34;
  const short = (s: string) => (s.length > NAME_MAX ? `${s.slice(0, NAME_MAX - 1).trimEnd()}…` : s);
  if (lay.nodes.length === 0) return <Empty caption={caption} />;
  const navigate = useNavigate();
  const teamTone = new Map(input.teams.map((t, i) => [`1:${t.id}`, SANKEY_TONES[i % SANKEY_TONES.length]]));
  // A person takes the colour of the team that gives them most.
  const personTone = new Map<string, string>();
  for (const l of lay.links) {
    if (!l.target.startsWith('2:')) continue;
    const cur = personTone.get(l.target);
    const best = lay.links.filter((x) => x.target === l.target).sort((a, b) => b.value - a.value)[0];
    if (!cur && best) personTone.set(l.target, teamTone.get(best.source) ?? 'var(--neon)');
  }
  const toneOf = (id: string) => teamTone.get(id) ?? personTone.get(id) ?? 'var(--neon)';
  // Labels never overlap (2026-11-09, the owner's report): each column's
  // labels are spread to at least two lines apart, top to bottom, then pulled
  // back up from the bottom edge if the last ran off the canvas.
  const labelY = new Map<string, number>();
  for (const col of [0, 1, 2] as const) {
    const single = !!oneLine && col === 2;
    const LINE = single ? PITCH : 40;
    const ns = lay.nodes.filter((n) => n.column === col).sort((a, b) => a.y - b.y);
    const ys = ns.map((n) => n.y + n.h / 2);
    for (let i = 1; i < ys.length; i++) ys[i] = Math.max(ys[i], ys[i - 1] + LINE);
    const max = H - pad - (single ? pad + 8 : 16);
    if (ys.length && ys[ys.length - 1] > max) {
      ys[ys.length - 1] = max;
      for (let i = ys.length - 2; i >= 0; i--) ys[i] = Math.min(ys[i], ys[i + 1] - LINE);
    }
    ns.forEach((n, i) => labelY.set(n.id, single ? ys[i] : ys[i] - 8));
  }
  return (
    <div className="chart">
      {caption && <div className="chart-caption">{caption}</div>}
      <svg viewBox={`0 0 ${W} ${H}`} className="sankey" role="img" aria-label={caption ?? 'Flow'}>
        <g transform={`translate(${labelW},${pad})`}>
          {lay.links.map((l) => (
            <path key={`${l.source}-${l.target}`} d={l.path} className="sankey-band" fill={toneOf(l.source.startsWith('0:') ? l.target : l.source)}>
              <title>{`${lay.nodes.find((n) => n.id === l.source)?.label} → ${lay.nodes.find((n) => n.id === l.target)?.label}: ${format(l.value)}`}</title>
            </path>
          ))}
          {lay.nodes.map((n) => {
            const left = n.column === 2;
            const tx = left ? n.x + lay.nodeWidth + 8 : n.x - 8;
            const anchor = left ? 'start' : 'end';
            const words = n.column === 0 ? `${format(n.value)} · 100%` : `${format(n.value)} · ${n.pct}%`;
            const label =
              oneLine && n.column === 2 ? (
                <text x={tx} y={labelY.get(n.id) ?? n.y + n.h / 2} className="sankey-label" textAnchor={anchor}>
                  <title>{`${n.label}: ${format(n.value)} (${n.pct}%)`}</title>
                  <tspan className="sankey-name">{short(n.label)}</tspan>
                  <tspan className="sankey-figure" dx="6">{`· ${words}`}</tspan>
                </text>
              ) : (
                <text x={tx} y={labelY.get(n.id) ?? n.y + n.h / 2} className="sankey-label" textAnchor={anchor}>
                  <tspan className="sankey-name">{n.label}</tspan>
                  <tspan className="sankey-figure" x={tx} dy="1.2em">
                    {words}
                  </tspan>
                </text>
              );
            return (
              <g key={n.id}>
                <rect x={n.x} y={n.y} width={lay.nodeWidth} height={Math.max(2, n.h)} rx={2} fill={n.column === 0 ? 'var(--text)' : toneOf(n.id)} className="sankey-node">
                  <title>{`${n.label}: ${format(n.value)} (${n.pct}%)`}</title>
                </rect>
                {n.to ? (
                  <a
                    href={n.to}
                    className="sankey-link"
                    onClick={(e) => {
                      e.preventDefault();
                      navigate(n.to!);
                    }}
                  >
                    {label}
                  </a>
                ) : (
                  label
                )}
              </g>
            );
          })}
        </g>
      </svg>
    </div>
  );
}

const SANKEY_TONES = ['var(--neon)', 'var(--info)', 'var(--magenta)', 'var(--warn)', '#2E9A4B', '#5B2A8C'];

// ── Shared ───────────────────────────────────────────────────────────────────

/**
 * Nothing to draw yet. Says so in words, because an empty chart frame is
 * indistinguishable from one that failed to load.
 */
function Empty({ caption }: { caption?: string }) {
  return (
    <div className="chart">
      {caption && <div className="chart-caption">{caption}</div>}
      <div className="chart-empty">Nothing recorded yet.</div>
    </div>
  );
}

/** A titled block on a dashboard, so every section is built the same way. */
export function Panel({
  title,
  blurb,
  children,
  action,
}: {
  title: string;
  blurb?: string;
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <section className="card panel-block">
      <div className="panel-head">
        <h3 className="card-title">{title}</h3>
        {action}
      </div>
      {blurb && <p className="panel-blurb">{blurb}</p>}
      {children}
    </section>
  );
}

/** One team's share of a listed set, as the API's summaries send `teams` (shared/team.ts). */
export interface TeamShare {
  id: string | null;
  code: string;
  name: string;
  count: number;
  value: number;
}

/**
 * The lists' team cards (2026-10-09, the owner's call: "there should be 8
 * cards, separate card by team"): one `Stat` per active team — KAT, HIT,
 * UIT, GIB, SIT — its value over its count. Rows whose owner has no team
 * are said by `noTeamNote()` on the count card, never a card of their own.
 */
export function teamCards(teams: TeamShare[] | undefined, money: (v: number) => string, noun = 'quotation') {
  return (teams ?? [])
    .filter((t) => t.id !== null)
    .map((t) => <Stat key={t.id} label={t.code} value={money(t.value)} figure sub={`${t.count} ${noun}${t.count === 1 ? '' : 's'}`} />);
}

export function noTeamNote(teams: TeamShare[] | undefined): string | undefined {
  const none = (teams ?? []).find((t) => t.id === null);
  return none?.count ? `${none.count} with no team` : undefined;
}
