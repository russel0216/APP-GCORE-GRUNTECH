import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { IconBadge, type IconName } from './Icon';

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
