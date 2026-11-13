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
  /** `of` groups the nodes of one thing (a customer shown under each team that sold to it); `last` sorts a node after its team's others. */
  people: { id: string; label: string; value: number; to?: string; of?: string; last?: boolean }[];
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
export function layoutSankey(input: SankeyInput, opts: { width: number; height: number; nodeWidth?: number; gap?: number; pitch?: number } = { width: 720, height: 360 }): SankeyLayout {
  const nodeWidth = opts.nodeWidth ?? 14;
  const gap = opts.gap ?? 10;
  // `pitch` (2026-11-10, the owner's report: the names drifted off their
  // bars) is the least room from one node's top to the next's, so a label
  // as tall as `pitch` sits beside its own node: a small node keeps its
  // height and is given that room, the scale shrinking until every column
  // still fits.
  const pitch = opts.pitch ?? 0;
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
    .sort((a, b) => a.at - b.at || Number(!!a.last) - Number(!!b.last) || b.value - a.value);

  if (total <= 0 || teams.length === 0) {
    return { width: opts.width, height: opts.height, nodeWidth, nodes: [], links: [] };
  }

  // One scale for every column: the column with the most nodes has the least
  // room left for bands, and the root must stand as tall as the others.
  const most = Math.max(1, teams.length, people.length);
  const usable = Math.max(1, opts.height - gap * (most - 1));
  const step = (h: number) => Math.max(h + gap, pitch);
  const columnH = (items: { value: number }[], s: number) =>
    items.reduce((sum, i, k) => sum + (k === items.length - 1 ? i.value * s : step(i.value * s)), 0);
  let scale = usable / total;
  if (pitch > 0) {
    // The largest scale at which every column, its pitches kept, fits.
    const fits = (s: number) => [[{ value: total }], teams, people].every((c) => columnH(c, s) <= opts.height + 0.01);
    if (!fits(scale)) {
      let lo = 0;
      let hi = scale;
      for (let k = 0; k < 40; k++) {
        const mid = (lo + hi) / 2;
        if (fits(mid)) lo = mid;
        else hi = mid;
      }
      scale = lo;
    }
  }
  const stack = (items: { id: string; label: string; value: number; to?: string }[], column: 0 | 1 | 2, x: number): SankeyNode[] => {
    const totalH = columnH(items, scale);
    let y = Math.max(0, (opts.height - totalH) / 2);
    return items.map((i) => {
      const h = i.value * scale;
      const node: SankeyNode = { id: `${column}:${i.id}`, column, label: i.label, value: round(i.value), pct: share(i.value, total), x, y: round(y), h: round(h), to: i.to };
      y += step(h);
      return node;
    });
  };
  const xs: [number, number, number] = [0, Math.round((opts.width - nodeWidth) / 2), opts.width - nodeWidth];
  const teamNodes = stack(teams, 1, xs[1]);
  // A last column that holds only PART of the flow (2026-11-13: the report
  // filtered to salespeople keeps Gruntech and every team in view and lists
  // only the ticked people or their customers) is not centred: each node
  // starts level with the top of its own team, where its band leaves, and
  // the rest of the team's bar stands with nothing flowing out of it.
  const partial = people.reduce((sum, p) => sum + p.value, 0) < total * 0.999;
  const anchored = (): SankeyNode[] => {
    let y = 0;
    const placed = people.map((p) => {
      const h = p.value * scale;
      const top = Math.max(y, teamNodes[p.at]?.y ?? 0);
      y = top + step(h);
      return { p, top, h };
    });
    const last = placed[placed.length - 1];
    const over = last ? Math.max(0, last.top + last.h - opts.height) : 0;
    return placed.map(({ p, top, h }) => ({ id: `2:${p.id}`, column: 2 as const, label: p.label, value: round(p.value), pct: share(p.value, total), x: xs[2], y: round(Math.max(0, top - over)), h: round(h), to: p.to }));
  };
  const nodes = [...stack([{ id: 'root', label: input.root.label, value: total }], 0, xs[0]), ...teamNodes, ...(partial ? anchored() : stack(people, 2, xs[2]))];
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

/**
 * The top `n` of a flow's last column, the rest gathered (2026-11-12, the
 * owner's call: "can also select top 25 or top 10 etc. customer"). Nodes are
 * ranked by what their `of` group holds in all (a customer under two teams is
 * one customer), and every node outside the top `n` groups is folded into ONE
 * node per team, "Other customers (k)", drawn last under its team — so the
 * columns still add up to the root. `n` of 0 or less keeps everything.
 */
export function topOfFlow(input: SankeyInput, n: number, otherLabel = 'Other customers'): SankeyInput {
  if (!(n > 0)) return input;
  const groupOf = (p: { id: string; of?: string }) => p.of ?? p.id;
  const totals = new Map<string, number>();
  for (const p of input.people) totals.set(groupOf(p), (totals.get(groupOf(p)) ?? 0) + p.value);
  if (totals.size <= n) return input;
  const keep = new Set(
    [...totals.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, n)
      .map(([k]) => k),
  );
  const kept = input.people.filter((p) => keep.has(groupOf(p)));
  const keptIds = new Set(kept.map((p) => p.id));
  const groupById = new Map(input.people.map((p) => [p.id, groupOf(p)]));
  const rest = new Map<string, { value: number; groups: Set<string> }>();
  for (const l of input.links) {
    if (keptIds.has(l.person)) continue;
    const cur = rest.get(l.team) ?? { value: 0, groups: new Set<string>() };
    cur.value += l.value;
    cur.groups.add(groupById.get(l.person) ?? l.person);
    rest.set(l.team, cur);
  }
  const others = [...rest.entries()].map(([team, r]) => ({ team, node: { id: `other:${team}`, label: `${otherLabel} (${r.groups.size})`, value: round(r.value), last: true } }));
  return {
    root: input.root,
    teams: input.teams,
    people: [...kept, ...others.map((o) => o.node)],
    links: [...input.links.filter((l) => keptIds.has(l.person)), ...others.map((o) => ({ team: o.team, person: o.node.id, value: o.node.value }))],
  };
}
