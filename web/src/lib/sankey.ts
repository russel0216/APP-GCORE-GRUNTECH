/**
 * The Sankey layout (2026-11-08, the owner's call: "a Sankey diagram,
 * Gruntech → Team → Individual Sales, showing the sales amount and %").
 *
 * Three columns, DOM-free, so verify-foundation can pin it: one root node, a
 * node per team, a node per person — a person ONCE whatever roles they hold
 * and however many teams their orders were tagged with (a second team is a
 * second incoming band, never a second node). Every node's height is its
 * value on one scale per column, so the three columns stand equally tall,
 * and every node carries its value and its share of the root for the
 * component to print (a chart is readable without colour). A band is a
 * cubic bezier from the source's stacked offset to the target's.
 */

export interface SankeyInput {
  root: { label: string; value: number };
  teams: { id: string; label: string; value: number; to?: string }[];
  people: { id: string; label: string; value: number; to?: string }[];
  links: { team: string; person: string; value: number }[];
}

export interface SankeyNode {
  id: string;
  column: 0 | 1 | 2;
  label: string;
  value: number;
  /** Share of the root, to one decimal. */
  pct: number;
  x: number;
  y: number;
  h: number;
  to?: string;
}

export interface SankeyLink {
  source: string;
  target: string;
  value: number;
  /** The SVG path of the band, closed, for a filled shape. */
  path: string;
  /** Where the band leaves and lands, for a tooltip. */
  y0: number;
  y1: number;
  h: number;
}

export interface SankeyLayout {
  width: number;
  height: number;
  nodeWidth: number;
  nodes: SankeyNode[];
  links: SankeyLink[];
}

export const share = (part: number, whole: number) => (whole > 0 ? Math.round((part / whole) * 1000) / 10 : 0);

const round = (n: number) => Math.round(n * 100) / 100;

/**
 * Lays the flow out in a `width` × `height` box. `gap` is the room between
 * two nodes of one column; the column with the most nodes decides the scale,
 * so every column fits and the root alone stands as tall as the people
 * together. Teams are kept in the order given (the API sorts by value);
 * people are grouped under the team that gives them most, then by value, so
 * the bands cross as little as a stacked layout allows.
 */
export function layoutSankey(input: SankeyInput, opts: { width: number; height: number; nodeWidth?: number; gap?: number } = { width: 720, height: 360 }): SankeyLayout {
  const nodeWidth = opts.nodeWidth ?? 14;
  const gap = opts.gap ?? 10;
  const total = input.root.value;
  const teams = input.teams.filter((t) => t.value > 0);
  const linkValue = (team: string, person: string) => input.links.filter((l) => l.team === team && l.person === person).reduce((s, l) => s + l.value, 0);
  // A person's place: under the team giving them most, by value within it.
  const people = input.people
    .filter((p) => p.value > 0)
    .map((p) => {
      let best = -1;
      let at = teams.length;
      teams.forEach((t, i) => {
        const v = linkValue(t.id, p.id);
        if (v > best) {
          best = v;
          at = i;
        }
      });
      return { ...p, at };
    })
    .sort((a, b) => a.at - b.at || b.value - a.value);

  if (total <= 0 || teams.length === 0) {
    return { width: opts.width, height: opts.height, nodeWidth, nodes: [], links: [] };
  }

  // One scale for every column: the column with the most nodes has the least
  // room left for bands, and the root must stand as tall as the others.
  const most = Math.max(1, teams.length, people.length);
  const usable = Math.max(1, opts.height - gap * (most - 1));
  const scale = usable / total;
  const stack = (items: { id: string; label: string; value: number; to?: string }[], column: 0 | 1 | 2, x: number): SankeyNode[] => {
    const totalH = items.reduce((s, i) => s + i.value * scale, 0) + gap * (items.length - 1);
    let y = Math.max(0, (opts.height - totalH) / 2);
    return items.map((i) => {
      const h = i.value * scale;
      const node: SankeyNode = { id: `${column}:${i.id}`, column, label: i.label, value: round(i.value), pct: share(i.value, total), x, y: round(y), h: round(h), to: i.to };
      y += h + gap;
      return node;
    });
  };
  const xs: [number, number, number] = [0, Math.round((opts.width - nodeWidth) / 2), opts.width - nodeWidth];
  const nodes = [
    ...stack([{ id: 'root', label: input.root.label, value: total }], 0, xs[0]),
    ...stack(teams, 1, xs[1]),
    ...stack(people, 2, xs[2]),
  ];
  const byId = new Map(nodes.map((n) => [n.id, n]));

  // Bands: root → each team (in team order), team → each of its people (in
  // the people's order), each leaving its source and landing on its target
  // at the next free offset, so the bands on one node stack without overlap.
  const out = new Map<string, number>();
  const into = new Map<string, number>();
  const band = (source: SankeyNode, target: SankeyNode, value: number): SankeyLink => {
    const h = value * scale;
    const y0 = source.y + (out.get(source.id) ?? 0);
    const y1 = target.y + (into.get(target.id) ?? 0);
    out.set(source.id, (out.get(source.id) ?? 0) + h);
    into.set(target.id, (into.get(target.id) ?? 0) + h);
    const x0 = source.x + nodeWidth;
    const x1 = target.x;
    const cx = (x0 + x1) / 2;
    const path = [
      `M${x0},${round(y0)}`,
      `C${cx},${round(y0)} ${cx},${round(y1)} ${x1},${round(y1)}`,
      `L${x1},${round(y1 + h)}`,
      `C${cx},${round(y1 + h)} ${cx},${round(y0 + h)} ${x0},${round(y0 + h)}`,
      'Z',
    ].join(' ');
    return { source: source.id, target: target.id, value: round(value), path, y0: round(y0), y1: round(y1), h: round(h) };
  };
  const links: SankeyLink[] = [];
  const root = byId.get('0:root')!;
  for (const t of teams) links.push(band(root, byId.get(`1:${t.id}`)!, t.value));
  for (const t of teams) {
    for (const p of people) {
      const v = linkValue(t.id, p.id);
      if (v > 0) links.push(band(byId.get(`1:${t.id}`)!, byId.get(`2:${p.id}`)!, v));
    }
  }
  return { width: opts.width, height: opts.height, nodeWidth, nodes, links };
}
