import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { Avatar, Empty, ErrorBox, Loading } from '../../components/ui';

/*
  The organisational chart: who reports to whom, drawn from the one place G-CORE
  keeps it — each login's "Reports to" (User.supervisorId), the same field every
  approval step routes by. It keeps no copy of its own, so the chart and the
  approvals can never disagree; to move someone, change their "Reports to".

  The top person heads it; their direct reports sit in a row under them; below
  that each branch runs downwards. Anyone whose manager is missing or switched
  off heads a tree of their own beside it, so nobody silently drops out.
*/

interface Person {
  id: string;
  name: string;
  position: string | null;
  isActive: boolean;
  photoPath: string | null;
  supervisor: { id: string; name: string } | null;
  department: { id: string; name: string } | null;
  /** Their team (the employee record's), and the teams they back-support. */
  team?: { id: string; code: string; name: string } | null;
  supportTeams?: { industryId: string; industry?: { code: string } }[];
}

interface Node {
  person: Person;
  reports: Node[];
}

/** Everyone active, arranged under their manager. A loop in "Reports to" cannot hang the page. */
function buildForest(people: Person[]): Node[] {
  const active = people.filter((p) => p.isActive);
  const byId = new Map(active.map((p) => [p.id, p]));
  const children = new Map<string, Person[]>();
  for (const p of active) {
    const boss = p.supervisor?.id;
    if (boss && byId.has(boss) && boss !== p.id) {
      children.set(boss, [...(children.get(boss) ?? []), p]);
    }
  }
  const placed = new Set<string>();
  const grow = (p: Person): Node => {
    placed.add(p.id);
    const reports = (children.get(p.id) ?? [])
      .filter((c) => !placed.has(c.id))
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(grow);
    return { person: p, reports };
  };
  // Heads: nobody above them, or their manager is not an active account.
  const heads = active
    .filter((p) => !p.supervisor || !byId.has(p.supervisor.id))
    .sort((a, b) => countBelow(b.id, children) - countBelow(a.id, children) || a.name.localeCompare(b.name));
  const forest = heads.map(grow);
  // A loop (A reports to B, B to A) has no head; start it from whoever is left.
  for (const p of active) if (!placed.has(p.id)) forest.push(grow(p));
  return forest;
}

function countBelow(id: string, children: Map<string, Person[]>, seen = new Set<string>()): number {
  if (seen.has(id)) return 0;
  seen.add(id);
  return (children.get(id) ?? []).reduce((n, c) => n + 1 + countBelow(c.id, children, seen), 0);
}

/** Each card registers itself so the Back Support lines can find it. */
type CardRef = (id: string, el: HTMLElement | null) => void;
let registerCard: CardRef = () => {};

function Card({ node, depth, meId, search }: { node: Node; depth: number; meId?: string; search: string }) {
  const p = node.person;
  const supports = (p.supportTeams ?? []).map((t) => t.industry?.code).filter(Boolean);
  return (
    <Link
      ref={(el) => registerCard(p.id, el)}
      to={`/admin/users/${p.id}${search}`}
      className={`org-card org-depth-${Math.min(depth, 3)}`}
    >
      <Avatar name={p.name} photoId={p.photoPath} size={36} />
      <span className="org-card-text">
        <span className="org-name">
          {p.name}
          {p.id === meId && <span className="org-you"> (you)</span>}
        </span>
        <span className="org-position">{p.position || p.department?.name || '—'}</span>
        {supports.length > 0 && <span className="org-supports">Back Support → {supports.join(', ')}</span>}
      </span>
      {node.reports.length > 0 && <span className="visually-hidden">, {node.reports.length} direct reports</span>}
    </Link>
  );
}

/** A branch from the third level down: the card, then its people in a column. */
function Branch({ node, depth, meId, search }: { node: Node; depth: number; meId?: string; search: string }) {
  return (
    <li>
      <Card node={node} depth={depth} meId={meId} search={search} />
      {node.reports.length > 0 && (
        <ul className="org-column">
          {node.reports.map((r) => (
            <Branch key={r.person.id} node={r} depth={depth + 1} meId={meId} search={search} />
          ))}
        </ul>
      )}
    </li>
  );
}

function Tree({ head, meId, search }: { head: Node; meId?: string; search: string }) {
  return (
    <div className="org-tree">
      <Card node={head} depth={0} meId={meId} search={search} />
      {head.reports.length > 0 && (
        <ul className="org-row">
          {head.reports.map((r) => (
            <li key={r.person.id} className="org-row-item">
              <Card node={r} depth={1} meId={meId} search={search} />
              {r.reports.length > 0 && (
                <ul className="org-column">
                  {r.reports.map((c) => (
                    <Branch key={c.person.id} node={c} depth={2} meId={meId} search={search} />
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function OrgChart() {
  const { me } = useAuth();
  const location = useLocation();
  const [people, setPeople] = useState<Person[] | null>(null);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    api
      .get<{ rows: Person[] }>('/users?pageSize=200&isActive=true')
      .then((r) => setPeople(r.rows))
      .catch(setError);
  }, []);

  const forest = useMemo(() => (people ? buildForest(people) : []), [people]);

  // Back Support lines (2026-10-19): from each supporter to the head of every
  // team they support — the team member whose own manager is on no other card
  // of that team (the Team Leader, as the chart is drawn).
  const links = useMemo(() => {
    if (!people) return [];
    const active = people.filter((p) => p.isActive);
    const byId = new Map(active.map((p) => [p.id, p]));
    const heads = new Map<string, Person>();
    for (const p of active) {
      if (!p.team) continue;
      const boss = p.supervisor ? byId.get(p.supervisor.id) : undefined;
      if (boss?.team?.id === p.team.id) continue;
      if (!heads.has(p.team.id)) heads.set(p.team.id, p);
    }
    const out: { from: string; to: string; code: string }[] = [];
    for (const p of active) {
      for (const t of p.supportTeams ?? []) {
        const head = heads.get(t.industryId);
        if (head && head.id !== p.id) out.push({ from: p.id, to: head.id, code: t.industry?.code ?? '' });
      }
    }
    return out;
  }, [people]);
  const [showLinks, setShowLinks] = useState(true);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const cards = useRef(new Map<string, HTMLElement>());
  registerCard = useCallback<CardRef>((id, el) => {
    if (el) cards.current.set(id, el);
    else cards.current.delete(id);
  }, []);
  const [lines, setLines] = useState<{ d: string; x: number; y: number; code: string; key: string }[]>([]);
  const [box, setBox] = useState({ w: 0, h: 0 });
  useLayoutEffect(() => {
    const root = scrollRef.current;
    if (!root || !showLinks) return setLines([]);
    const draw = () => {
      const base = root.getBoundingClientRect();
      const at = (el: HTMLElement) => {
        const r = el.getBoundingClientRect();
        return { right: r.right - base.left + root.scrollLeft, y: r.top - base.top + r.height / 2 };
      };
      // Each line leaves the supporter's right edge and swings out to the
      // right before entering the team head's — clear of the cards between.
      const next = links.flatMap((l, i) => {
        const a = cards.current.get(l.from);
        const b = cards.current.get(l.to);
        if (!a || !b) return [];
        const s = at(a);
        const e = at(b);
        const out = Math.max(s.right, e.right) + 48 + i * 28;
        const d = `M ${s.right} ${s.y} C ${out} ${s.y}, ${out} ${e.y}, ${e.right + 2} ${e.y}`;
        return [{ d, x: out - 10, y: (s.y + e.y) / 2, code: l.code, key: `${l.from}-${l.to}-${i}` }];
      });
      setBox({ w: root.scrollWidth + 240, h: root.scrollHeight });
      setLines(next);
    };
    draw();
    const ro = new ResizeObserver(draw);
    ro.observe(root);
    return () => ro.disconnect();
  }, [links, showLinks, forest]);
  // The chart itself is a head plus everyone under them; lone accounts (no
  // manager, nobody reporting to them) are listed apart so they read as "not placed yet".
  const trees = forest.filter((t) => t.reports.length > 0);
  const loose = forest.filter((t) => t.reports.length === 0);

  if (error) return <ErrorBox error={error} />;
  if (!people) return <Loading />;
  if (forest.length === 0) return <Empty title="Nobody to chart yet" hint="Add users, then set who each reports to." />;

  return (
    <div className="card org-card-wrap">
      <p className="muted org-lead">
        Drawn from each person's <strong>Reports to</strong> — the same line their leave, overtime and other approvals
        follow. Open anyone to change it.
      </p>
      {links.length > 0 && (
        <label className="org-switch">
          <input type="checkbox" checked={showLinks} onChange={(e) => setShowLinks(e.target.checked)} /> Show Back Support
          lines to the teams they support
        </label>
      )}
      <div className="org-scroll" ref={scrollRef}>
        {lines.length > 0 && (
          <svg className="org-links" width={box.w} height={box.h} aria-hidden="true">
            <defs>
              <marker id="org-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
                <path d="M0,0 L10,5 L0,10 z" className="org-link-head" />
              </marker>
            </defs>
            {lines.map((l) => (
              <g key={l.key}>
                <path d={l.d} className="org-link" markerEnd="url(#org-arrow)" />
                <text x={l.x} y={l.y} className="org-link-label">
                  {l.code}
                </text>
              </g>
            ))}
          </svg>
        )}
        {trees.map((t) => (
          <Tree key={t.person.id} head={t} meId={me?.user.id} search={location.search} />
        ))}
      </div>
      {loose.length > 0 && (
        <div className="org-loose">
          <h3 className="card-title">Not placed yet</h3>
          <p className="muted">
            No one set as their manager, and nobody reports to them. Open them to set <strong>Reports to</strong>.
          </p>
          <ul className="org-loose-list">
            {loose.map((t) => (
              <li key={t.person.id}>
                <Card node={t} depth={3} meId={me?.user.id} search={location.search} />
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
