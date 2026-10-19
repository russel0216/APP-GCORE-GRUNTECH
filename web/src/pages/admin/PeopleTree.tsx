import { useMemo, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { useAuth } from '../../lib/auth';
import { levelLabel } from '../../lib/roleLevels';
import { Avatar, Empty, ErrorBox, Loading } from '../../components/ui';
import { buildForest, useOrgPeople, type Node } from './OrgChart';

/*
  The people hierarchy (2026-10-19, the owner's call: "remove the department,
  create a hierarchy"): everyone under whoever they report to, as an outline
  that opens and closes — the Organizational Chart's own forest (`buildForest`,
  from "Reports to"), read as a list. Each line says the person's title (their
  highest role), its level, their team and how many report to them.
*/

/** Everyone in a branch, for the search: a match keeps its managers on screen. */
function matches(node: Node, term: string): boolean {
  const p = node.person;
  const hay = [p.name, p.title ?? p.position ?? '', p.team?.code ?? ''].join(' ').toLowerCase();
  return hay.includes(term) || node.reports.some((r) => matches(r, term));
}

function countAll(node: Node): number {
  return node.reports.reduce((n, r) => n + 1 + countAll(r), 0);
}

function Line({
  node,
  depth,
  open,
  toggle,
  term,
  meId,
  search,
}: {
  node: Node;
  depth: number;
  open: Set<string>;
  toggle: (id: string) => void;
  term: string;
  meId?: string;
  search: string;
}) {
  const p = node.person;
  const reports = term ? node.reports.filter((r) => matches(r, term)) : node.reports;
  const expanded = !!term || open.has(p.id);
  const rank = (p.roles ?? []).reduce<number | null>((best, r) => (r.rank != null && (best == null || r.rank < best) ? r.rank : best), null);
  return (
    <li className="ptree-item" aria-level={depth + 1}>
      <div className="ptree-line">
        {node.reports.length > 0 ? (
          <button
            type="button"
            className="ptree-toggle"
            aria-expanded={expanded}
            aria-label={`${expanded ? 'Close' : 'Open'} ${p.name}'s reports`}
            onClick={() => toggle(p.id)}
            disabled={!!term}
          >
            {expanded ? '▾' : '▸'}
          </button>
        ) : (
          <span className="ptree-toggle ptree-leaf" aria-hidden="true" />
        )}
        <Avatar name={p.name} photoId={p.photoPath} size={28} />
        <Link to={`/admin/users/${p.id}${search}`} className="ptree-name">
          {p.name}
          {p.id === meId && <span className="faint"> (you)</span>}
        </Link>
        <span className="ptree-title">{p.title ?? p.position ?? '—'}</span>
        {rank != null && <span className="badge">{levelLabel(rank)}</span>}
        {p.team && (
          <span className="badge info" title={p.team.name}>
            {p.team.code}
          </span>
        )}
        {node.reports.length > 0 && (
          <span className="faint ptree-count">
            {node.reports.length} direct · {countAll(node)} in all
          </span>
        )}
      </div>
      {expanded && reports.length > 0 && (
        <ul className="ptree-list">
          {reports.map((r) => (
            <Line key={r.person.id} node={r} depth={depth + 1} open={open} toggle={toggle} term={term} meId={meId} search={search} />
          ))}
        </ul>
      )}
    </li>
  );
}

export function PeopleTree() {
  const { me } = useAuth();
  const location = useLocation();
  const { people, error } = useOrgPeople();
  const forest = useMemo(() => (people ? buildForest(people) : []), [people]);
  // The top two levels open to start with; everything below is a click away.
  const [open, setOpen] = useState<Set<string> | null>(null);
  const [q, setQ] = useState('');
  const initial = useMemo(() => new Set(forest.flatMap((h) => [h.person.id, ...h.reports.map((r) => r.person.id)])), [forest]);
  const opened = open ?? initial;
  const all = useMemo(() => {
    const ids: string[] = [];
    const walk = (n: Node) => {
      if (n.reports.length) ids.push(n.person.id);
      n.reports.forEach(walk);
    };
    forest.forEach(walk);
    return ids;
  }, [forest]);

  if (error) return <ErrorBox error={error} />;
  if (!people) return <Loading />;
  if (forest.length === 0) return <Empty title="Nobody to show yet" hint="Add users, then set who each reports to." />;

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
        <h3 className="card-title">Hierarchy</h3>
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
        Everyone under the person they <strong>Report to</strong> — the line their approvals follow — with their title (the
        highest of their roles) and its level. Open anyone to change it.
      </p>
      <input
        type="search"
        className="ptree-search"
        placeholder="Find a person, title or team…"
        aria-label="Find a person, title or team"
        value={q}
        onChange={(e) => setQ(e.target.value)}
      />
      {heads.length === 0 ? (
        <Empty title="Nobody matches" />
      ) : (
        <ul className="ptree-list ptree-root" role="list">
          {heads.map((h) => (
            <Line key={h.person.id} node={h} depth={0} open={opened} toggle={toggle} term={term} meId={me?.user.id} search={location.search} />
          ))}
        </ul>
      )}
    </div>
  );
}
