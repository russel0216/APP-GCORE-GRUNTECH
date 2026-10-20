import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { Avatar, Empty, ErrorBox, Loading } from '../../components/ui';
import { levelLabel } from '../../lib/roleLevels';

/*
  The organisational chart: who reports to whom, drawn from the one place G-CORE
  keeps it — each login's "Reports to" (User.supervisorId), the same field every
  approval step routes by. It keeps no copy of its own, so the chart and the
  approvals can never disagree; to move someone, change their "Reports to".

  The top person heads it; their direct reports sit in a row under them; below
  that each branch runs downwards. Anyone whose manager is missing or switched
  off heads a tree of their own beside it, so nobody silently drops out.
*/

export interface Person {
  id: string;
  name: string;
  position: string | null;
  isActive: boolean;
  photoPath: string | null;
  supervisor: { id: string; name: string } | null;
  /** Their team (the employee record's), and the teams they back-support. */
  team?: { id: string; code: string; name: string } | null;
  /** Their roles, with each one's level — the Hierarchy view shows them. */
  roles?: { key: string; name: string; rank?: number | null }[];
  /** Their highest role — the title on documents. */
  title?: string | null;
  supportTeams?: { industryId: string; industry?: { code: string } }[];
}

export interface Node {
  person: Person;
  reports: Node[];
}

/** Everyone active, arranged under their manager. A loop in "Reports to" cannot hang the page. */
export function buildForest(people: Person[]): Node[] {
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

/** The managing roles a team turns to — marked on a card wherever they are held. */
const KEY_ROLES = new Set(['technical_manager', 'sales_manager', 'team_leader', 'service_manager']);

/** The teams in the owner's order; any other after them. */
const TEAM_ORDER = ['KAT', 'HIT', 'UIT', 'GIB', 'SIT'];
const teamRank = (code?: string) => {
  const i = TEAM_ORDER.indexOf(code ?? '');
  return i < 0 ? TEAM_ORDER.length : i;
};

/*
  One tile per ROLE, the holder's picture on each (2026-10-19, the owner's
  call: "scatter their picture per role so it is easy to see what is lacking
  and who they report to down the line"). A person holding three roles shows
  three tiles side by side in one box; the box is what reports to its manager.
*/
function Card({ node, depth, meId, search, only }: { node: Node; depth: number; meId?: string; search: string; only?: Set<string> }) {
  const p = node.person;
  const roles = [...(p.roles ?? [])].filter((r) => !only || only.has(r.key)).sort((a, b) => (a.rank ?? 99) - (b.rank ?? 99) || a.name.localeCompare(b.name));
  const tiles = roles.length > 0 ? roles.map((r) => ({ key: r.key, name: r.name })) : [{ key: '', name: p.position || 'No role yet' }];
  return (
    <span className={`org-person org-depth-${Math.min(depth, 3)}`}>
      {tiles.map((t) => (
        <Link key={t.key || 'none'} to={`/admin/users/${p.id}${search}`} className={`org-card${KEY_ROLES.has(t.key) ? ' is-key' : ''}`}>
          <Avatar name={p.name} photoId={p.photoPath} size={36} />
          <span className="org-card-text">
            {p.team && (
              <span className="org-team" title={p.team.name}>
                {p.team.code}
              </span>
            )}
            <span className="org-position">{t.name}</span>
            <span className="org-name">
              {p.name}
              {p.id === meId && <span className="org-you"> (you)</span>}
            </span>
          </span>
        </Link>
      ))}
      {node.reports.length > 0 && <span className="visually-hidden">, {node.reports.length} direct reports</span>}
    </span>
  );
}

/** The managing roles nobody on a team holds — drawn as empty tiles. */
function Vacant({ team, missing }: { team: { code: string; name: string }; missing: string[] }) {
  if (missing.length === 0) return null;
  return (
    <span className="org-person org-vacant-set">
      {missing.map((name) => (
        <span key={name} className="org-card is-vacant">
          <span className="org-card-text">
            <span className="org-team" title={team.name}>
              {team.code}
            </span>
            <span className="org-position">{name}</span>
            <span className="org-name">Vacant</span>
          </span>
        </span>
      ))}
    </span>
  );
}

const KEY_ROLE_NAMES: Record<string, string> = {
  team_leader: 'Team Leader',
  technical_manager: 'Technical Manager',
  sales_manager: 'Sales Manager',
  service_manager: 'Aftermarket Manager',
};

/** Everyone on a branch, the branch head included. */
function membersOf(node: Node): Person[] {
  return [node.person, ...node.reports.flatMap(membersOf)];
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

function missingFor(node: Node, extra: string[] = []): string[] {
  const team = node.person.team?.id;
  const held = new Set(
    membersOf(node)
      .filter((m) => m.team?.id === team)
      .flatMap((m) => (m.roles ?? []).map((r) => r.key))
      .concat(extra),
  );
  return Object.keys(KEY_ROLE_NAMES).filter((k) => !held.has(k)).map((k) => KEY_ROLE_NAMES[k]);
}

/** The head's other roles, drawn where they are worked (a team's, or BOSS). */
type Lent = { node: Node; keys: Set<string> };

function RowItem({ node, meId, search, lent }: { node: Node; meId?: string; search: string; lent?: Lent }) {
  return (
    <li className="org-row-item">
      {lent && <Card node={lent.node} depth={1} meId={meId} search={search} only={lent.keys} />}
      <Card node={node} depth={1} meId={meId} search={search} />
      {node.person.team && <Vacant team={node.person.team} missing={missingFor(node, lent ? [...lent.keys] : [])} />}
      {node.reports.length > 0 && (
        <ul className="org-column">
          {node.reports.map((c) => (
            <Branch key={c.person.id} node={c} depth={2} meId={meId} search={search} />
          ))}
        </ul>
      )}
    </li>
  );
}

/*
  Under the head the chart splits in two (2026-10-19, the owner's call): BOSS —
  Business and Operation Support Services, the people with no selling team — on
  the left, and the Industry Teams (KAT, HIT, UIT, GIB, SIT) on the right.
*/
function Tree({ head, meId, search }: { head: Node; meId?: string; search: string }) {
  // Only the head's highest role sits at the top; every other role they hold
  // is drawn where it is worked — a team role on their team's branch, the
  // rest on the BOSS side (2026-10-19, the owner's call).
  const roles = head.person.roles ?? [];
  const topRank = Math.min(...roles.map((r) => r.rank ?? 99), 99);
  const topKeys = new Set(roles.filter((r) => (r.rank ?? 99) === topRank).map((r) => r.key));
  const rest = roles.filter((r) => !topKeys.has(r.key));
  const teamKeys = new Set(rest.filter((r) => KEY_ROLES.has(r.key)).map((r) => r.key));
  const bossKeys = new Set(rest.filter((r) => !KEY_ROLES.has(r.key)).map((r) => r.key));
  const headTeam = head.person.team;
  const lone = (_keys: Set<string>): Node => ({ person: head.person, reports: [] });

  const boss = head.reports.filter((r) => !r.person.team);
  const industry = head.reports
    .filter((r) => r.person.team)
    .sort((a, b) => teamRank(a.person.team?.code) - teamRank(b.person.team?.code) || a.person.name.localeCompare(b.person.name));
  const teamRow = headTeam && teamKeys.size > 0 ? industry.find((r) => r.person.team?.id === headTeam.id) : undefined;
  type Item = { key: string; node: Node; lent?: Lent; onlyKeys?: Set<string> };
  const bossItems: Item[] = [
    ...(bossKeys.size > 0 ? [{ key: 'head-boss', node: lone(bossKeys), onlyKeys: bossKeys }] : []),
    ...boss.map((r) => ({ key: r.person.id, node: r })),
  ];
  const industryItems: Item[] = industry.map((r) =>
    r === teamRow ? { key: r.person.id, node: r, lent: { node: lone(teamKeys), keys: teamKeys } } : { key: r.person.id, node: r },
  );
  if (teamKeys.size > 0 && !teamRow) industryItems.push({ key: 'head-team', node: lone(teamKeys), onlyKeys: teamKeys });
  const sides = [
    { key: 'boss', label: 'BOSS — Business and Operation Support Services', items: bossItems },
    { key: 'industry', label: 'Industry Teams', items: industryItems },
  ].filter((x) => x.items.length > 0);
  return (
    <div className="org-tree">
      <Card node={head} depth={0} meId={meId} search={search} only={topKeys.size ? topKeys : undefined} />
      {sides.length > 0 && (
        <ul className="org-row">
          {sides.map((side) => (
            <li key={side.key} className="org-row-item org-side" style={{ flexGrow: side.items.length }}>
              <span className="org-side-label">{side.label}</span>
              <ul className="org-row">
                {side.items.map((it) =>
                  it.onlyKeys ? (
                    <li key={it.key} className="org-row-item">
                      <Card node={it.node} depth={1} meId={meId} search={search} only={it.onlyKeys} />
                    </li>
                  ) : (
                    <RowItem key={it.key} node={it.node} meId={meId} search={search} lent={it.lent} />
                  ),
                )}
              </ul>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * Everyone active with their "Reports to" — the chart's and the Hierarchy
 * view's one read of the admin user list (the only screen allowed it: it
 * needs every Reports to).
 */
export function useOrgPeople(): { people: Person[] | null; error: unknown } {
  const [people, setPeople] = useState<Person[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => {
    api
      .get<{ rows: Person[] }>('/users?pageSize=200&isActive=true')
      .then((r) => setPeople(r.rows))
      .catch(setError);
  }, []);
  return { people, error };
}

/** A role as the chart reads it (`GET /roles/chart`). */
export interface ChartRole {
  id: string;
  key: string;
  name: string;
  rank: number | null;
  reportsToRoleId: string | null;
  alsoReportsToRoleIds: string[];
}

export interface RoleNode {
  role: ChartRole;
  children: RoleNode[];
}

/**
 * The roles as Admin › Roles › Hierarchy arranges them (2026-10-20, the
 * owner's call): each role's tile under the role it reports to, its holders'
 * pictures on it, "Vacant" where nobody holds it. A role reporting to two
 * (the Warehouse Supervisor to both Purchasing Managers) is drawn under the
 * first and names the others on its tile.
 */
export function roleForest(roles: ChartRole[]): RoleNode[] {
  const nodes = new Map(roles.map((r) => [r.id, { role: r, children: [] as RoleNode[] }]));
  const roots: RoleNode[] = [];
  for (const r of roles) {
    const parentId = r.reportsToRoleId ?? r.alsoReportsToRoleIds[0];
    const parent = parentId ? nodes.get(parentId) : undefined;
    if (parent && parentId !== r.id) parent.children.push(nodes.get(r.id)!);
    else roots.push(nodes.get(r.id)!);
  }
  // A loop saved before the check existed would hide its roles; break it.
  const placed = new Set<string>();
  const walk = (n: RoleNode) => {
    placed.add(n.role.id);
    n.children = n.children.filter((c) => !placed.has(c.role.id));
    n.children.forEach(walk);
  };
  roots.forEach(walk);
  for (const n of nodes.values()) if (!placed.has(n.role.id)) { roots.push(n); walk(n); }
  return roots;
}

function RoleTile({ node, holders, names, meId, search, rolesOnly }: { node: RoleNode; holders: Person[]; names: Map<string, string>; meId?: string; search: string; rolesOnly?: boolean }) {
  const r = node.role;
  const also = [r.reportsToRoleId ? r.alsoReportsToRoleIds : r.alsoReportsToRoleIds.slice(1)]
    .flat()
    .map((id) => names.get(id))
    .filter(Boolean);
  return (
    <span className="org-person">
      {rolesOnly ? (
        <span className={`org-card is-role${KEY_ROLES.has(r.key) ? ' is-key' : ''}`}>
          <span className="org-card-text">
            {r.rank != null && <span className="org-position">{levelLabel(r.rank)}</span>}
            <span className="org-name">{r.name}</span>
          </span>
        </span>
      ) : holders.length === 0 ? (
        <span className="org-card is-vacant">
          <span className="org-card-text">
            <span className="org-position">{r.name}</span>
            <span className="org-name">Vacant</span>
          </span>
        </span>
      ) : (
        holders.map((p) => (
          <Link key={p.id} to={`/admin/users/${p.id}${search}`} className={`org-card${KEY_ROLES.has(r.key) ? ' is-key' : ''}`}>
            <Avatar name={p.name} photoId={p.photoPath} size={36} />
            <span className="org-card-text">
              {p.team && (
                <span className="org-team" title={p.team.name}>
                  {p.team.code}
                </span>
              )}
              <span className="org-position">{r.name}</span>
              <span className="org-name">
                {p.name}
                {p.id === meId && <span className="org-you"> (you)</span>}
              </span>
            </span>
          </Link>
        ))
      )}
      {also.length > 0 && <span className="org-also">Also reports to {also.join(' and ')}</span>}
    </span>
  );
}

function RoleBranch(props: { node: RoleNode; byRole: Map<string, Person[]>; names: Map<string, string>; meId?: string; search: string; rolesOnly?: boolean }) {
  const { node, byRole } = props;
  return (
    <li className="org-row-item">
      <RoleTile {...props} holders={byRole.get(node.role.key) ?? []} />
      {node.children.length > 0 && (
        <ul className="org-row">
          {node.children.map((c) => (
            <RoleBranch key={c.role.id} {...props} node={c} />
          ))}
        </ul>
      )}
    </li>
  );
}

function RoleChart({ people, meId, search, onReady, rolesOnly }: { people: Person[]; meId?: string; search: string; onReady: () => void; rolesOnly?: boolean }) {
  const [roles, setRoles] = useState<ChartRole[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => {
    api.get<ChartRole[]>('/roles/chart').then(setRoles).catch(setError);
  }, []);
  // Fit the canvas once the tiles are on it.
  useEffect(() => {
    if (roles) requestAnimationFrame(onReady);
  }, [roles, onReady]);
  const byRole = useMemo(() => {
    const m = new Map<string, Person[]>();
    for (const p of people) for (const r of p.roles ?? []) m.set(r.key, [...(m.get(r.key) ?? []), p]);
    for (const list of m.values()) list.sort((a, b) => teamRank(a.team?.code) - teamRank(b.team?.code) || a.name.localeCompare(b.name));
    return m;
  }, [people]);
  if (error) return <ErrorBox error={error} />;
  if (!roles) return <Loading />;
  const names = new Map(roles.map((r) => [r.id, r.name]));
  const forest = roleForest(roles);
  const props = { byRole, names, meId, search, rolesOnly };
  // The head (the top role with roles under it) keeps the chart's two sides:
  // BOSS — the roles whose branch holds nobody on a selling team — and the
  // Industry Teams (2026-10-20, the owner's call).
  const head = [...forest].filter((n) => n.children.length).sort((a, b) => (a.role.rank ?? 99) - (b.role.rank ?? 99))[0];
  const onTeam = (n: RoleNode): boolean =>
    (byRole.get(n.role.key) ?? []).some((p) => !!p.team) || n.children.some(onTeam);
  const others = forest.filter((n) => n !== head);
  const sides = head
    ? [
        { key: 'boss', label: 'BOSS — Business and Operation Support Services', items: head.children.filter((c) => !onTeam(c)) },
        { key: 'industry', label: 'Industry Teams', items: head.children.filter(onTeam) },
      ].filter((s) => s.items.length > 0)
    : [];
  return (
    <div className="org-tree is-roles">
      {head && (
        <>
          <RoleTile {...props} node={head} holders={byRole.get(head.role.key) ?? []} />
          <ul className="org-row">
            {sides.map((side) => (
              <li key={side.key} className="org-row-item org-side" style={{ flexGrow: side.items.length }}>
                <span className="org-side-label">{side.label}</span>
                <ul className="org-row">
                  {side.items.map((n) => (
                    <RoleBranch key={n.role.id} {...props} node={n} />
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        </>
      )}
      {others.filter((n) => n.children.length).length > 0 && (
        <ul className="org-row">
          {others.filter((n) => n.children.length).map((n) => (
            <RoleBranch key={n.role.id} {...props} node={n} />
          ))}
        </ul>
      )}
      {/* A role with no parent and nothing under it is not placed yet: wrapped, never one endless row. */}
      {others.some((n) => !n.children.length) && (
        <div className="org-loose">
          <h3 className="card-title">Not placed in the hierarchy yet</h3>
          <ul className="org-loose-list">
            {others.filter((n) => !n.children.length).map((n) => (
              <li key={n.role.id}>
                <RoleTile {...props} node={n} holders={byRole.get(n.role.key) ?? []} />
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

export function OrgChart({ rolesOnly }: { rolesOnly?: boolean } = {}) {
  const { me } = useAuth();
  const location = useLocation();
  const { people, error } = useOrgPeople();
  // By role is the chart (2026-10-20); by person is the "Reports to" lines.
  const [byPerson, setByPerson] = useState(false);

  const forest = useMemo(() => (people ? buildForest(people) : []), [people]);

  // The chart itself is a head plus everyone under them; lone accounts (no
  // manager, nobody reporting to them) are listed apart so they read as "not placed yet".
  const trees = forest.filter((t) => t.reports.length > 0);
  const loose = forest.filter((t) => t.reports.length === 0);

  // The whole chart fits the width on opening, however small; zoom to read.
  const outer = useRef<HTMLDivElement | null>(null);
  const wrap = useRef<HTMLDivElement | null>(null);
  // Grip: drag the chart to look around it; a drag never opens the card it started on.
  const drag = useRef<{ x: number; y: number; left: number; top: number; moved: boolean } | null>(null);
  const [dragging, setDragging] = useState(false);
  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || !outer.current) return;
    drag.current = { x: e.clientX, y: e.clientY, left: outer.current.scrollLeft, top: outer.current.scrollTop, moved: false };
  };
  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    const o = outer.current;
    if (!d || !o) return;
    const dx = e.clientX - d.x;
    const dy = e.clientY - d.y;
    if (!d.moved && Math.abs(dx) + Math.abs(dy) < 5) return;
    if (!d.moved) {
      d.moved = true;
      setDragging(true);
      o.setPointerCapture(e.pointerId);
    }
    o.scrollLeft = d.left - dx;
    o.scrollTop = d.top - dy;
  };
  const endDrag = () => {
    const d = drag.current;
    drag.current = null;
    if (d?.moved) {
      setDragging(false);
      // Swallow the click that ends a drag.
      window.addEventListener('click', (ev) => ev.preventDefault(), { capture: true, once: true });
    }
  };
  const [full, setFull] = useState(false);
  useEffect(() => {
    const on = () => {
      setFull(document.fullscreenElement === wrap.current);
      requestAnimationFrame(() => requestAnimationFrame(() => fitRef.current()));
    };
    document.addEventListener('fullscreenchange', on);
    return () => document.removeEventListener('fullscreenchange', on);
  }, []);
  const toggleFull = () => {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void wrap.current?.requestFullscreen?.();
  };
  const inner = useRef<HTMLDivElement | null>(null);
  const [zoom, setZoom] = useState(1);
  const fit = useCallback(() => {
    const o = outer.current;
    const i = inner.current;
    if (!o || !i) return;
    const natural = i.scrollWidth;
    if (natural > 0) setZoom(Math.max(0.2, Math.min(1, +(o.clientWidth / natural).toFixed(2))));
  }, []);
  const fitRef = useRef(fit);
  fitRef.current = fit;
  const fitted = useRef(false);
  useLayoutEffect(() => {
    if (fitted.current || !inner.current) return;
    fitted.current = true;
    fit();
  });
  useEffect(() => {
    requestAnimationFrame(fit);
  }, [byPerson, fit]);

  if (error) return <ErrorBox error={error} />;
  if (!people) return <Loading />;
  if (forest.length === 0) return <Empty title="Nobody to chart yet" hint="Add users, then set who each reports to." />;

  return (
    <div className="card org-card-wrap" ref={wrap}>
      {!rolesOnly && (
      <div className="row org-switch">
        <div className="scope-switch">
          <button type="button" className={byPerson ? '' : 'active'} aria-pressed={!byPerson} onClick={() => setByPerson(false)}>
            By role
          </button>
          <button type="button" className={byPerson ? 'active' : ''} aria-pressed={byPerson} onClick={() => setByPerson(true)}>
            By person
          </button>
        </div>
      </div>
      )}
      <p className="muted org-lead">
        {rolesOnly ? (
          <>
            Each role under the role it reports to, as set on <strong>Roles &amp; Permissions › Hierarchy</strong>.
          </>
        ) : byPerson ? (
          <>
            Drawn from each person's <strong>Reports to</strong> — the same line their leave, overtime and other approvals
            follow. Open anyone to change it.
          </>
        ) : (
          <>
            Each role under the role it reports to, as set on <strong>Roles &amp; Permissions › Hierarchy</strong>, with
            the people who hold it. A role nobody holds reads <strong>Vacant</strong>.
          </>
        )}
      </p>
      <div className="org-zoom" role="group" aria-label="Zoom">
        <button type="button" className="btn btn-sm" onClick={() => setZoom((z) => Math.max(0.2, +(z - 0.1).toFixed(2)))} aria-label="Zoom out">
          −
        </button>
        <span className="org-zoom-value">{Math.round(zoom * 100)}%</span>
        <button type="button" className="btn btn-sm" onClick={() => setZoom((z) => Math.min(2, +(z + 0.1).toFixed(2)))} aria-label="Zoom in">
          +
        </button>
        <button type="button" className="btn btn-sm" onClick={fit}>
          Fit
        </button>
        <button type="button" className="btn btn-sm" onClick={() => setZoom(1)}>
          100%
        </button>
        {typeof document !== 'undefined' && document.fullscreenEnabled && (
          <button type="button" className="btn btn-sm" onClick={toggleFull}>
            {full ? 'Exit full screen' : 'Full screen'}
          </button>
        )}
        <span className="faint org-grip-hint">Drag the chart to move around it.</span>
      </div>
      <div
        className={`org-scroll${dragging ? ' is-dragging' : ''}`}
        ref={outer}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
      >
        <div className="org-canvas" ref={inner} style={{ zoom }}>
          {byPerson ? (
            trees.map((t) => <Tree key={t.person.id} head={t} meId={me?.user.id} search={location.search} />)
          ) : (
            <RoleChart people={people} meId={me?.user.id} search={location.search} onReady={fit} rolesOnly={rolesOnly} />
          )}
        </div>
      </div>
      {byPerson && loose.length > 0 && (
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
