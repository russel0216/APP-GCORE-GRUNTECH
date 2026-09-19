/**
 * The S-curve — planned vs actual vs billed (model §5.3).
 *
 * Three lines, one chart, drawn as inline SVG so it needs no charting library
 * and prints. The gap between planned and actual is schedule slip; the gap
 * between actual and billed is work done but not invoiced. Neither is visible
 * from a single curve, which is the whole reason there are three.
 */

export interface CurvePoint {
  date: string;
  planned: number;
  actual: number | null;
  billed: number | null;
}

const W = 720;
const H = 260;
const PAD = { top: 16, right: 16, bottom: 34, left: 44 };

export function SCurve({ points }: { points: CurvePoint[] }) {
  if (points.length < 2) {
    return (
      <div className="muted" style={{ padding: 30, textAlign: 'center' }}>
        The curve appears once the schedule of values has planned dates and the first progress
        report is approved.
      </div>
    );
  }

  const innerW = W - PAD.left - PAD.right;
  const innerH = H - PAD.top - PAD.bottom;

  const t0 = new Date(points[0].date).getTime();
  const t1 = new Date(points[points.length - 1].date).getTime();
  const span = Math.max(1, t1 - t0);

  const x = (date: string) => PAD.left + ((new Date(date).getTime() - t0) / span) * innerW;
  const y = (pct: number) => PAD.top + innerH - (Math.max(0, Math.min(100, pct)) / 100) * innerH;

  function path(key: 'planned' | 'actual' | 'billed'): string {
    const pts = points.filter((p) => p[key] !== null && p[key] !== undefined);
    if (pts.length < 2) return '';
    return pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(p.date).toFixed(1)},${y(p[key] as number).toFixed(1)}`).join(' ');
  }

  const last = points[points.length - 1];
  const lastActual = [...points].reverse().find((p) => p.actual !== null);
  const lastBilled = [...points].reverse().find((p) => p.billed !== null);

  // A month-ish tick spacing that stays readable whatever the job length.
  const tickCount = Math.min(6, points.length);
  const ticks = Array.from({ length: tickCount }, (_, i) =>
    points[Math.round((i * (points.length - 1)) / Math.max(1, tickCount - 1))],
  );

  return (
    <div>
      <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', height: 'auto' }} role="img" aria-label="S-curve">
        {/* Horizontal gridlines at 25% intervals */}
        {[0, 25, 50, 75, 100].map((pct) => (
          <g key={pct}>
            <line
              x1={PAD.left}
              x2={W - PAD.right}
              y1={y(pct)}
              y2={y(pct)}
              stroke="var(--line)"
              strokeWidth="1"
            />
            <text x={PAD.left - 8} y={y(pct) + 4} textAnchor="end" fontSize="10" fill="var(--faint)">
              {pct}%
            </text>
          </g>
        ))}

        {ticks.map((p, i) => (
          <text
            key={`${p.date}-${i}`}
            x={x(p.date)}
            y={H - 12}
            textAnchor="middle"
            fontSize="9"
            fill="var(--faint)"
          >
            {new Date(p.date).toLocaleDateString('en-PH', { day: 'numeric', month: 'short' })}
          </text>
        ))}

        <path d={path('planned')} fill="none" stroke="var(--muted)" strokeWidth="2" strokeDasharray="5 4" />
        <path d={path('billed')} fill="none" stroke="var(--magenta)" strokeWidth="2" />
        <path d={path('actual')} fill="none" stroke="var(--neon)" strokeWidth="2.5" />

        {lastActual?.actual != null && (
          <circle cx={x(lastActual.date)} cy={y(lastActual.actual)} r="4" fill="var(--neon)" />
        )}
        {lastBilled?.billed != null && (
          <circle cx={x(lastBilled.date)} cy={y(lastBilled.billed)} r="3.5" fill="var(--magenta)" />
        )}
      </svg>

      <div className="row" style={{ gap: 18, justifyContent: 'center', marginTop: 4 }}>
        <Legend color="var(--muted)" dashed label={`Planned ${last.planned.toFixed(1)}%`} />
        <Legend color="var(--neon)" label={`Actual ${lastActual?.actual?.toFixed(1) ?? '0.0'}%`} />
        <Legend color="var(--magenta)" label={`Billed ${lastBilled?.billed?.toFixed(1) ?? '0.0'}%`} />
      </div>
    </div>
  );
}

function Legend({ color, label, dashed }: { color: string; label: string; dashed?: boolean }) {
  return (
    <span className="row" style={{ gap: 6, fontSize: 12 }}>
      <svg width="22" height="8">
        <line
          x1="0"
          y1="4"
          x2="22"
          y2="4"
          stroke={color}
          strokeWidth="2.5"
          strokeDasharray={dashed ? '5 4' : undefined}
        />
      </svg>
      <span className="muted">{label}</span>
    </span>
  );
}
