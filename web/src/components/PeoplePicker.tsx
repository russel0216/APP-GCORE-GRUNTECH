import { useMemo, useState } from 'react';

/**
 * Pick several people from a list — meeting invitees, session attendees,
 * clearance signatories.
 *
 * Pure UI: the caller fetches `/users/lookup` or `/employees/lookup` and maps
 * the rows to `{ id, name, sub, group }`. This component never knows which
 * of the two it is showing, which is the point — a User and an Employee are
 * different records (Phase 2) and the picker must not care.
 *
 * Everything is reachable from the keyboard: the rows are real checkboxes in
 * real labels, each chip's remove is a button, and Enter in the search box
 * toggles the first visible row so a name can be added without leaving the
 * field.
 */

export interface Person {
  id: string;
  name: string;
  /** Second line — a position, an email, a department. */
  sub?: string;
  /** Rows are grouped under this heading; absent rows go under "Everyone". */
  group?: string;
}

const UNGROUPED = 'Everyone';

export function PeoplePicker({
  people,
  value,
  onChange,
  exclude = [],
  max,
}: {
  people: Person[];
  value: string[];
  onChange: (ids: string[]) => void;
  /** Ids never offered — the organiser, the person being evaluated. */
  exclude?: string[];
  max?: number;
}) {
  const [q, setQ] = useState('');

  const selected = useMemo(() => new Set(value), [value]);
  const excluded = useMemo(() => new Set(exclude), [exclude]);
  const byId = useMemo(() => new Map(people.map((p) => [p.id, p])), [people]);
  const full = max !== undefined && value.length >= max;

  const visible = useMemo(() => {
    const term = q.trim().toLowerCase();
    return people.filter(
      (p) =>
        !excluded.has(p.id) &&
        (!term || p.name.toLowerCase().includes(term) || (p.sub ?? '').toLowerCase().includes(term)),
    );
  }, [people, excluded, q]);

  // Keep the caller's order of groups: the API already sorts by department
  // then name, and re-sorting here would undo that.
  const groups = useMemo(() => {
    const map = new Map<string, Person[]>();
    for (const p of visible) {
      const key = p.group ?? UNGROUPED;
      const list = map.get(key) ?? [];
      list.push(p);
      map.set(key, list);
    }
    return [...map.entries()];
  }, [visible]);

  function toggle(id: string) {
    if (selected.has(id)) onChange(value.filter((v) => v !== id));
    else if (!full) onChange([...value, id]);
  }

  function addAll(list: Person[]) {
    const next = [...value];
    for (const p of list) {
      if (max !== undefined && next.length >= max) break;
      if (!selected.has(p.id)) next.push(p.id);
    }
    onChange(next);
  }

  function onSearchKey(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    if (visible[0]) toggle(visible[0].id);
  }

  return (
    <div className="people-picker">
      {value.length > 0 && (
        <div className="chips" aria-label="Selected people">
          {value.map((id) => {
            const p = byId.get(id);
            return (
              <span key={id} className="chip">
                {p?.name ?? id}
                <button
                  type="button"
                  className="chip-remove"
                  aria-label={`Remove ${p?.name ?? id}`}
                  onClick={() => toggle(id)}
                >
                  ×
                </button>
              </span>
            );
          })}
        </div>
      )}

      <input
        type="search"
        placeholder="Search people…"
        aria-label="Search people"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        onKeyDown={onSearchKey}
      />

      {max !== undefined && (
        <div className="faint picker-note">
          {value.length} of {max} chosen
        </div>
      )}

      <div className="rows">
        {groups.length === 0 ? (
          <div className="faint picker-note">Nobody matches.</div>
        ) : (
          groups.map(([group, list]) => {
            const remaining = list.filter((p) => !selected.has(p.id));
            return (
              <div key={group} className="group">
                <div className="group-head">
                  <span>{group}</span>
                  {remaining.length > 0 && !full && (
                    <button type="button" className="btn btn-sm" onClick={() => addAll(list)}>
                      Add all
                    </button>
                  )}
                </div>
                {list.map((p) => {
                  const on = selected.has(p.id);
                  return (
                    <label key={p.id} className={`person${on ? ' on' : ''}`}>
                      <input
                        type="checkbox"
                        checked={on}
                        disabled={!on && full}
                        onChange={() => toggle(p.id)}
                      />
                      <span className="person-name">{p.name}</span>
                      {p.sub && <span className="person-sub faint">{p.sub}</span>}
                    </label>
                  );
                })}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
