import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { levelLabel } from '../../lib/roleLevels';
import { Empty, ErrorBox, Loading } from '../../components/ui';
import { roleForest, type ChartRole, type RoleNode } from './OrgChart';

/*
  The Hierarchy Chart (2026-10-20, the owner's call: "it should be Hierarchy
  Chart, where the Admin › Roles › Hierarchy settings reflect — no name or
  person"): the ROLES under the roles they report to, as an outline that opens
  and closes, each with its level and any other role it also reports to. No
  person is named here; who holds a role is the Organizational Chart's.
*/

function matches(node: RoleNode, term: string): boolean {
  return node.role.name.toLowerCase().includes(term) || node.children.some((c) => matches(c, term));
}

function countAll(node: RoleNode): number {
  return node.children.reduce((n, c) => n + 1 + countAll(c), 0);
}

function Line({
  node,
  depth,
  open,
  toggle,
  term,
  names,
}: {
  node: RoleNode;
  depth: number;
  open: Set<string>;
  toggle: (id: string) => void;
  term: string;
  names: Map<string, string>;
}) {
  const r = node.role;
  const children = term ? node.children.filter((c) => matches(c, term)) : node.children;
  const expanded = !!term || open.has(r.id);
  const also = (r.reportsToRoleId ? r.alsoReportsToRoleIds : r.alsoReportsToRoleIds.slice(1))
    .map((id) => names.get(id))
    .filter(Boolean);
  return (
    <li className="ptree-item" aria-level={depth + 1}>
      <div className="ptree-line">
        {node.children.length > 0 ? (
          <button
            type="button"
            className="ptree-toggle"
            aria-expanded={expanded}
            aria-label={`${expanded ? 'Close' : 'Open'} the roles under ${r.name}`}
            onClick={() => toggle(r.id)}
            disabled={!!term}
          >
            {expanded ? '▾' : '▸'}
          </button>
        ) : (
          <span className="ptree-toggle ptree-leaf" aria-hidden="true" />
        )}
        <span className="ptree-name">{r.name}</span>
        {r.rank != null && <span className="badge">{levelLabel(r.rank)}</span>}
        {also.length > 0 && <span className="ptree-title">Also reports to {also.join(' and ')}</span>}
        {node.children.length > 0 && (
          <span className="faint ptree-count">
            {node.children.length} direct · {countAll(node)} in all
          </span>
        )}
      </div>
      {expanded && children.length > 0 && (
        <ul className="ptree-list">
          {children.map((c) => (
            <Line key={c.role.id} node={c} depth={depth + 1} open={open} toggle={toggle} term={term} names={names} />
          ))}
        </ul>
      )}
    </li>
  );
}

export function PeopleTree() {
  const { can } = useAuth();
  const [roles, setRoles] = useState<ChartRole[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => {
    api.get<ChartRole[]>('/roles/chart').then(setRoles).catch(setError);
  }, []);
  const forest = useMemo(() => (roles ? roleForest(roles) : []), [roles]);
  const names = useMemo(() => new Map((roles ?? []).map((r) => [r.id, r.name])), [roles]);
  const [open, setOpen] = useState<Set<string> | null>(null);
  const [q, setQ] = useState('');
  const all = useMemo(() => {
    const ids: string[] = [];
    const walk = (n: RoleNode) => {
      if (n.children.length) ids.push(n.role.id);
      n.children.forEach(walk);
    };
    forest.forEach(walk);
    return ids;
  }, [forest]);
  // Everything open to start with: a role chart is small enough to read whole.
  const opened = open ?? new Set(all);

  if (error) return <ErrorBox error={error} />;
  if (!roles) return <Loading />;
  if (forest.length === 0) return <Empty title="No roles yet" hint="Add roles in Admin › Roles." />;

  const term = q.trim().toLowerCase();
  const toggle = (id: string) => {
    const next = new Set(opened);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setOpen(next);
  };
  const heads = term ? forest.filter((h) => matches(h, term)) : forest;

  return (
    <div className="card">
      <div className="card-head">
        <h3 className="card-title">Hierarchy Chart</h3>
        <div className="row">
          <button type="button" className="btn btn-sm" onClick={() => setOpen(new Set(all))}>
            Open all
          </button>
          <button type="button" className="btn btn-sm" onClick={() => setOpen(new Set())}>
            Close all
          </button>
        </div>
      </div>
      <p className="muted">
        Each role under the role it reports to, as set in{' '}
        {can('admin.roles.view_all') ? <Link to="/admin/roles?view=hierarchy">Roles › Hierarchy</Link> : 'Roles › Hierarchy'}.
      </p>
      <input
        type="search"
        className="ptree-search"
        placeholder="Find a role…"
        aria-label="Find a role"
        value={q}
        onChange={(e) => setQ(e.target.value)}
      />
      {heads.length === 0 ? (
        <Empty title="No role matches" />
      ) : (
        <ul className="ptree-list ptree-root" role="list">
          {heads.map((h) => (
            <Line key={h.role.id} node={h} depth={0} open={opened} toggle={toggle} term={term} names={names} />
          ))}
        </ul>
      )}
    </div>
  );
}
