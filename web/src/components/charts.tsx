import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';

/**
 * The chart set.
 *
 * Hand-rolled SVG and CSS, no charting library — the same reason the rest of
 * this app has no UI framework, and these are four shapes rather than forty.
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
  value: number;
  tone?: Tone;
  /** The list this slice counted — a figure you cannot open is a dead end. */
  to?: string;
}

// ── Stat ─────────────────────────────────────────────────────────────────────

/**
 * One number and what it means. The unit of every dashboard here.
 *
 * `value` of `null` means "could not be read", which is not zero and must not
 * look like it — a dash says so.
 */
export function Stat({
  label,
  value,
  hint,
  tone,
  to,
}: {
  label: string;
  value: number | string | null;
  hint?: string;
  /** Applied only when the value is non-zero: zero is usually the good news. */
  tone?: Tone;
  to?: string;
}) {
  const live = typeof value === 'number' ? value > 0 : Boolean(value);
  const body = (
    <>
      <div className="section-label">{label}</div>
      <div
        className="stat-value"
        style={live && tone ? { color: TONE_VAR[tone] } : undefined}
      >
        {value === null ? '—' : value}
      </div>
      {hint && <div className="stat-hint">{hint}</div>}
    </>
  );
  return to ? (
    <Link to={to} className="card clickable stat">
      {body}
    </Link>
  ) : (
    <div className="card stat">{body}</div>
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
              <span className="bar-value">{s.value}</span>
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
              <span className="funnel-value">{stage.value}</span>
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
}: {
  slices: Slice[];
  caption?: string;
  centreLabel?: string;
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
                  <title>{`${s.label}: ${s.value}`}</title>
                </circle>
              );
              offset += len;
              return el;
            })}
          <text x="70" y="66" className="donut-total">
            {total}
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
              <strong>{s.value}</strong>
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
