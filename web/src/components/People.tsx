import { useEffect, useId, useState } from 'react';
import { api, qs } from '../lib/api';
import type { Person } from './PeoplePicker';

/*
  One way to list people, and one way to pick ONE of them (2026-10-09, the
  owner's call: uniformity of the Modify / editor screens across modules).

  Before this, 23 screens fetched `/users/lookup` by hand, each with its own
  row type and its own `<select>` — the project manager, the designer, the
  engineer on a visit, the owner filter on a list. `usePeople(holding)` is
  the one fetch (cached for the session, one request per `holding` however
  many forms ask), `PersonSelect` the one single-person control, and
  `toPerson()` feeds the multi-person `PeoplePicker` from the same rows.

  `/users/lookup` is open to anyone signed in and returns names, positions,
  departments and photos only — never the admin-gated `/users` (CLAUDE.md,
  "the people picker").
*/

export interface PersonRow {
  id: string;
  name: string;
  email?: string | null;
  position?: string | null;
  photoPath?: string | null;
  department?: { id: string; name: string } | null;
}

const cache = new Map<string, { at: number; rows: Promise<PersonRow[]> }>();
const FRESH_MS = 60_000;

/** The people holding `holding` (a permission key), or every active login. Cached a minute. */
export function loadPeople(holding?: string): Promise<PersonRow[]> {
  const key = holding ?? '';
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < FRESH_MS) return hit.rows;
  const rows = api.get<PersonRow[]>(`/users/lookup${qs({ holding: holding || undefined })}`).catch((err) => {
    cache.delete(key);
    throw err;
  });
  cache.set(key, { at: Date.now(), rows });
  return rows;
}

/** React to `loadPeople`. A refusal or an outage reads as nobody, never as a broken form. */
export function usePeople(holding?: string): { people: PersonRow[]; loading: boolean } {
  const [people, setPeople] = useState<PersonRow[]>([]);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let live = true;
    setLoading(true);
    loadPeople(holding)
      .then((rows) => live && setPeople(rows))
      .catch(() => live && setPeople([]))
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, [holding]);
  return { people, loading };
}

/** A lookup row as the multi-person `PeoplePicker` takes it. */
export function toPerson(row: PersonRow): Person {
  return {
    id: row.id,
    name: row.name,
    sub: row.position ?? row.email ?? undefined,
    group: row.department?.name,
    photoId: row.photoPath ?? null,
  };
}

/**
 * One person, from a list: a native select (the keyboard and the phone know
 * it), grouped by department when the people carry one, with "— none —"
 * unless the choice is required. A person already chosen who is no longer in
 * the list (left the role, deactivated) stays as an option, so opening an old
 * record never silently clears it — named through `current`, or, when the
 * caller has no name for them, as "someone not on this list".
 *
 * Inside a `Field` it is wired like a native select (`fieldControl`): the
 * label, the hint and the error reach it through `aria-describedby`.
 */
export function PersonSelect({
  id,
  value,
  onChange,
  people,
  placeholder = '— none —',
  required,
  disabled,
  current,
  self,
  invalid,
  describedBy,
  'aria-describedby': fieldDescribedBy,
  'aria-invalid': fieldInvalid,
}: {
  id?: string;
  value: string;
  onChange: (id: string) => void;
  people: PersonRow[];
  placeholder?: string;
  required?: boolean;
  disabled?: boolean;
  /** The person on the record now, shown even when not in `people`. */
  current?: { id: string; name: string } | null;
  /** The viewer's own id: their row reads "(you)". */
  self?: string | null;
  invalid?: boolean;
  describedBy?: string;
  /** Set by `Field`. */
  'aria-describedby'?: string;
  /** Set by `Field`. */
  'aria-invalid'?: boolean;
}) {
  const autoId = useId();
  const groups = new Map<string, PersonRow[]>();
  for (const p of people) {
    const g = p.department?.name ?? '';
    groups.set(g, [...(groups.get(g) ?? []), p]);
  }
  const grouped = groups.size > 1 || (groups.size === 1 && !groups.has(''));
  const listed = (pid: string) => people.some((p) => p.id === pid);
  const missing = current && !listed(current.id) ? current : null;
  // A value nobody can name (filled in from another record) still shows as
  // chosen, never as the first name in the list.
  const unnamed = value && !listed(value) && missing?.id !== value ? value : null;
  const you = (pid: string) => (self && pid === self ? ' (you)' : '');
  const option = (p: PersonRow) => (
    <option key={p.id} value={p.id}>
      {p.name}
      {you(p.id)}
      {p.position ? ` — ${p.position}` : ''}
    </option>
  );
  const described = [describedBy, fieldDescribedBy].filter(Boolean).join(' ') || undefined;
  return (
    <select
      id={id ?? autoId}
      value={value}
      required={required}
      disabled={disabled}
      aria-invalid={invalid || fieldInvalid || undefined}
      aria-describedby={described}
      onChange={(e) => onChange(e.target.value)}
    >
      {(!required || !value) && <option value="">{placeholder}</option>}
      {missing && (
        <option value={missing.id}>
          {missing.name}
          {you(missing.id)}
        </option>
      )}
      {unnamed && <option value={unnamed}>{people.length ? 'Someone not on this list' : '…'}</option>}
      {grouped
        ? [...groups.entries()].map(([g, rows]) => (
            <optgroup key={g || '—'} label={g || 'No department'}>
              {rows.map(option)}
            </optgroup>
          ))
        : people.map(option)}
    </select>
  );
}
// Field wires its label, hint and error to it as it does to a native select.
(PersonSelect as unknown as { fieldControl: boolean }).fieldControl = true;
