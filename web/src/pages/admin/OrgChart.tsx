import { useEffect, useMemo, useState } from 'react';
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
function Card({ node, depth, meId, search }: { node: Node; depth: number; meId?: string; search: string }) {
  const p = node.person;
  const roles = [...(p.roles ?? [])].sort((a, b) => (a.rank ?? 99) - (b.rank ?? 99) || a.name.localeCompare(b.name));
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

function missingFor(node: Node): string[] {
  const team = node.person.team?.id;
  const held = new Set(
    membersOf(node)
      .filter((m) => m.team?.id === team)
      .flatMap((m) => (m.roles ?? []).map((r) => r.key)),
  );
  return Object.keys(KEY_ROLE_NAMES).filter((k) => !held.has(k)).map((k) => KEY_ROLE_NAMES[k]);
}

function RowItem({ node, meId, search }: { node: Node; meId?: string; search: string }) {
  return (
    <li className="org-row-item">
      <Card node={node} depth={1} meId={meId} search={search} />
      {node.person.team && <Vacant team={node.person.team} missing={missingFor(node)} />}
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
  const boss = head.reports.filter((r) => !r.person.team);
  const industry = head.reports
    .filter((r) => r.person.team)
    .sort((a, b) => teamRank(a.person.team?.code) - teamRank(b.person.team?.code) || a.person.name.localeCompare(b.person.name));
  const sides = [
    { key: 'boss', label: 'BOSS — Business and Operation Support Services', nodes: boss },
    { key: 'industry', label: 'Industry Teams', nodes: industry },
  ].filter((x) => x.nodes.length > 0);
  return (
    <div className="org-tree">
      <Card node={head} depth={0} meId={meId} search={search} />
      {sides.length > 0 && (
        <ul className="org-row">
          {sides.map((side) => (
            <li key={side.key} className="org-row-item org-side" style={{ flexGrow: side.nodes.length }}>
              <span className="org-side-label">{side.label}</span>
              <ul className="org-row">
                {side.nodes.map((r) => (
                  <RowItem key={r.person.id} node={r} meId={meId} search={search} />
                ))}
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

export function OrgChart() {
  const { me } = useAuth();
  const location = useLocation();
  const { people, error } = useOrgPeople();

  const forest = useMemo(() => (people ? buildForest(people) : []), [people]);

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
      <div className="org-scroll">
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
