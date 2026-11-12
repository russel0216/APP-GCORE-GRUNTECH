import { useRef, useState } from 'react';
import { layoutSankey, type SankeyInput } from '../lib/sankey';

/**
 * A Sankey as a PICTURE for a slide (2026-11-12, the owner's call: "download
 * png or jpg for the sankey, salesperson and customer, so that I can save and
 * use it for a PowerPoint presentation").
 *
 * One 16:9 canvas, white, every colour and font written on the element itself
 * — never a class or a token — so the SVG reads the same in either theme and
 * can be drawn onto a canvas and saved as a PNG with nothing else on the page.
 *
 *   side   the flow left to right, two lines of label a node (the salespeople)
 *   down   the flow top to bottom: Gruntech across the top, the teams side by
 *          side under it, a column per customer with its name written down
 *          the picture — the Sales Report's own customer page
 */

const W = 1600;
const H = 900;
const INK = '#222222';
const GREY = '#666666';
const PURPLE = '#5B2A8C';
const TONES = ['#2E9A4B', '#3B6FD8', '#A62CB5', '#B07A1A', '#1F7A4D', '#5B2A8C'];
const FONT = 'Arial, Helvetica, sans-serif';

const compact = (v: number) => (Math.abs(v) >= 1e6 ? `${(v / 1e6).toFixed(2)}M` : Math.abs(v) >= 1e3 ? `${(v / 1e3).toFixed(1)}K` : v ? v.toFixed(0) : '0');
/** A fair guess at a line's width: there is no page to measure on. */
const widthOf = (text: string, size: number, bold: boolean) => text.length * size * (bold ? 0.63 : 0.54);
const cut = (text: string, room: number, size: number, bold: boolean) => {
  if (widthOf(text, size, bold) <= room) return text;
  const keep = Math.max(3, Math.floor(room / (size * (bold ? 0.63 : 0.54))) - 1);
  return `${text.slice(0, keep).trimEnd()}…`;
};

export function FlowPicture({ input, mode, title, subtitle, fileName }: { input: SankeyInput; mode: 'side' | 'down'; title: string; subtitle: string; fileName: string }) {
  const ref = useRef<SVGSVGElement>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState('');
  const save = async () => {
    if (!ref.current) return;
    setBusy(true);
    setProblem('');
    try {
      await savePng(ref.current, fileName);
    } catch {
      setProblem('The picture could not be saved — try again.');
    } finally {
      setBusy(false);
    }
  };
  const empty = input.root.value <= 0 || input.teams.every((t) => t.value <= 0);
  return (
    <div className="card">
      <div className="card-head">
        <h3 className="card-title">{title}</h3>
        <button type="button" className="btn btn-sm" onClick={save} disabled={busy || empty}>
          {busy ? 'Saving…' : 'Download PNG'}
        </button>
      </div>
      {problem && <p className="faint">{problem}</p>}
      {empty ? (
        <p className="faint">Nothing booked in this period.</p>
      ) : (
        <svg ref={ref} xmlns="http://www.w3.org/2000/svg" viewBox={`0 0 ${W} ${H}`} width={W} height={H} style={{ width: '100%', height: 'auto', display: 'block' }} role="img" aria-label={title}>
          <rect x={0} y={0} width={W} height={H} fill="#FFFFFF" />
          <text x={40} y={52} fontFamily={FONT} fontSize={26} fontWeight={700} fill={PURPLE}>
            {title}
          </text>
          <text x={40} y={80} fontFamily={FONT} fontSize={15} fill={GREY}>
            {subtitle}
          </text>
          {mode === 'down' ? <Down input={input} /> : <Side input={input} />}
        </svg>
      )}
    </div>
  );
}

function tones(input: SankeyInput, links: { source: string; target: string; value: number }[]) {
  const team = new Map(input.teams.map((t, i) => [`1:${t.id}`, TONES[i % TONES.length]]));
  return (id: string) => {
    if (id.startsWith('0:')) return INK;
    if (team.has(id)) return team.get(id)!;
    const best = links.filter((l) => l.target === id).sort((a, b) => b.value - a.value)[0];
    return (best && team.get(best.source)) ?? PURPLE;
  };
}

/** Left to right: Gruntech, the teams, the people — two lines of label a node. */
function Side({ input }: { input: SankeyInput }) {
  const top = 120;
  const labelL = 190;
  const labelR = 330;
  const left = 40 + labelL;
  const areaH = H - top - 40;
  const LINE = 46;
  const lay = layoutSankey(input, { width: W - 80 - labelL - labelR, height: areaH, nodeWidth: 20, gap: 18, pitch: LINE });
  const toneOf = tones(input, lay.links);
  const labelY = new Map<string, number>();
  for (const col of [0, 1, 2] as const) {
    const ns = lay.nodes.filter((n) => n.column === col).sort((a, b) => a.y - b.y);
    const ys = ns.map((n) => n.y + n.h / 2);
    for (let i = 1; i < ys.length; i++) ys[i] = Math.max(ys[i], ys[i - 1] + LINE);
    const max = areaH - 14;
    if (ys.length && ys[ys.length - 1] > max) {
      ys[ys.length - 1] = max;
      for (let i = ys.length - 2; i >= 0; i--) ys[i] = Math.min(ys[i], ys[i + 1] - LINE);
    }
    ns.forEach((n, i) => labelY.set(n.id, ys[i]));
  }
  return (
    <g transform={`translate(${left},${top})`}>
      {lay.links.map((l) => (
        <path key={`${l.source}-${l.target}`} d={l.path} fill={toneOf(l.source.startsWith('0:') ? l.target : l.source)} fillOpacity={0.3} />
      ))}
      {lay.nodes.map((n) => {
        const right = n.column === 2;
        const tx = right ? n.x + lay.nodeWidth + 12 : n.x - 12;
        const y = labelY.get(n.id) ?? n.y + n.h / 2;
        return (
          <g key={n.id}>
            <rect x={n.x} y={n.y} width={lay.nodeWidth} height={Math.max(2, n.h)} fill={toneOf(n.id)} />
            <text x={tx} y={y - 3} textAnchor={right ? 'start' : 'end'} fontFamily={FONT} fontSize={19} fontWeight={700} fill={INK}>
              {cut(n.label, (right ? labelR : labelL) - 16, 19, true)}
            </text>
            <text x={tx} y={y + 17} textAnchor={right ? 'start' : 'end'} fontFamily={FONT} fontSize={16} fill={GREY}>
              {`${compact(n.value)} · ${n.column === 0 ? 100 : n.pct}%`}
            </text>
          </g>
        );
      })}
    </g>
  );
}

/** Top to bottom: Gruntech, the teams side by side, a column per customer. */
function Down({ input }: { input: SankeyInput }) {
  const left = 40;
  const pW = W - 80;
  const bottom = H - 30;
  const count = Math.max(1, input.people.filter((p) => p.value > 0).length);
  // The columns take 85% of the width, so the bars keep room to stand to scale.
  const colW = Math.min(30, (pW * 0.85) / count);
  const size = Math.max(7, Math.min(17, colW - 1.5));
  const tailOf = (n: { value: number; pct: number }) => ` · ${compact(n.value)} · ${n.pct}%`;
  const longest = input.people.reduce((w, p) => Math.max(w, widthOf(p.label, size, true) + widthOf(' · 000.00M · 00.0%', size, false)), 0);
  const labelRoom = Math.min(430, Math.max(140, longest + 8));
  const top = 150;
  const nodeW = 18;
  const flowLen = bottom - labelRoom - 10 - top;
  // The layout's own axes run along the flow (x) and across it (y); the picture turns them.
  const lay = layoutSankey(input, { width: flowLen, height: pW, nodeWidth: nodeW, gap: Math.min(4, colW / 4), pitch: colW });
  const toneOf = tones(input, lay.links);
  const byId = new Map(lay.nodes.map((n) => [n.id, n]));
  const px = (across: number) => left + across;
  const py = (along: number) => top + along;
  const band = (l: (typeof lay.links)[number]) => {
    const s = byId.get(l.source)!;
    const t = byId.get(l.target)!;
    const y0 = py(s.x + nodeW);
    const y1 = py(t.x);
    const cy = (y0 + y1) / 2;
    return `M${px(l.y0)},${y0} C${px(l.y0)},${cy} ${px(l.y1)},${cy} ${px(l.y1)},${y1} L${px(l.y1 + l.h)},${y1} C${px(l.y1 + l.h)},${cy} ${px(l.y0 + l.h)},${cy} ${px(l.y0 + l.h)},${y0} Z`;
  };
  const root = byId.get('0:root');
  // The teams' labels stay level in ONE row over the bars; where the bars are
  // too narrow the row spreads evenly about them, a hairline to each bar.
  const teamLabels = lay.nodes
    .filter((n) => n.column === 1)
    .sort((a, b) => a.y - b.y)
    .map((n) => {
      const figure = `${compact(n.value)} · ${n.pct}%`;
      const w = Math.max(widthOf(n.label, 19, true), widthOf(figure, 15, false)) + 22;
      const bar = px(n.y + n.h / 2);
      return { n, figure, w, bar, x: bar };
    });
  for (let i = 1; i < teamLabels.length; i++) teamLabels[i].x = Math.max(teamLabels[i].x, teamLabels[i - 1].x + (teamLabels[i - 1].w + teamLabels[i].w) / 2);
  const drift = teamLabels.reduce((sum, t) => sum + (t.x - t.bar), 0) / Math.max(1, teamLabels.length);
  for (const t of teamLabels) t.x = Math.max(left + t.w / 2, Math.min(left + pW - t.w / 2, t.x - drift));
  const custs = lay.nodes.filter((n) => n.column === 2).sort((a, b) => a.y - b.y);
  const cxs = custs.map((n) => px(n.y + n.h / 2));
  for (let i = 1; i < cxs.length; i++) cxs[i] = Math.max(cxs[i], cxs[i - 1] + colW);
  const maxX = left + pW - colW / 2;
  if (cxs.length && cxs[cxs.length - 1] > maxX) {
    cxs[cxs.length - 1] = maxX;
    for (let i = cxs.length - 2; i >= 0; i--) cxs[i] = Math.min(cxs[i], cxs[i + 1] - colW);
  }
  const labelTop = py(flowLen) + 8;
  const room = bottom - labelTop;
  return (
    <g>
      {lay.links.map((l) => (
        <path key={`${l.source}-${l.target}`} d={band(l)} fill={toneOf(l.source.startsWith('0:') ? l.target : l.source)} fillOpacity={0.3} />
      ))}
      {lay.nodes.map((n) => (
        <rect key={n.id} x={px(n.y)} y={py(n.x)} width={Math.max(1.5, n.h)} height={nodeW} fill={toneOf(n.id)} />
      ))}
      {root && (
        <text x={px(root.y + root.h / 2)} y={py(root.x) - 12} textAnchor="middle" fontFamily={FONT} fontSize={21} fontWeight={700} fill={INK}>
          {`${root.label}  ·  ${compact(root.value)} · 100%`}
        </text>
      )}
      {teamLabels.map(({ n, figure, bar, x }) => {
        const barTop = py(n.x);
        const ty = barTop - 62;
        return (
          <g key={n.id}>
            <line x1={x} y1={ty + 26} x2={bar} y2={barTop} stroke={GREY} strokeWidth={0.8} />
            <text x={x} y={ty} textAnchor="middle" fontFamily={FONT} fontSize={19} fontWeight={700} fill={INK}>
              {n.label}
            </text>
            <text x={x} y={ty + 19} textAnchor="middle" fontFamily={FONT} fontSize={15} fill={INK}>
              {figure}
            </text>
          </g>
        );
      })}
      {custs.map((n, i) => {
        const tail = tailOf(n);
        const name = cut(n.label, Math.max(40, room - widthOf(tail, size, false)), size, true);
        return (
          <text key={n.id} transform={`translate(${cxs[i] - size * 0.35},${labelTop}) rotate(90)`} fontFamily={FONT} fontSize={size} fill={GREY}>
            <tspan fontWeight={700} fill={INK}>
              {name}
            </tspan>
            {tail}
          </text>
        );
      })}
    </g>
  );
}

/** Draws the SVG onto a canvas at twice its size and saves it as a PNG. */
async function savePng(svg: SVGSVGElement, fileName: string): Promise<void> {
  const text = new XMLSerializer().serializeToString(svg);
  const url = URL.createObjectURL(new Blob([text], { type: 'image/svg+xml;charset=utf-8' }));
  try {
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('The picture could not be drawn'));
      img.src = url;
    });
    const canvas = document.createElement('canvas');
    canvas.width = W * 2;
    canvas.height = H * 2;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('No canvas');
    ctx.fillStyle = '#FFFFFF';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
    if (!blob) throw new Error('No picture');
    const href = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = href;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(href), 10_000);
  } finally {
    URL.revokeObjectURL(url);
  }
}
