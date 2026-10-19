import { useMemo, useState } from 'react';
import { api } from '../../lib/api';
import { mayEdit, useAuth } from '../../lib/auth';
import { actionsFor, LEVEL_LABELS, levelOptions, levelsOf, type Level } from '../../lib/permissionLevels';
import { levelLabel, rolesByLevel } from '../../lib/roleLevels';
import { ErrorBox, Field, useToast } from '../../components/ui';
import { TickPicker } from '../../components/TickPicker';
import { useUnsavedChanges } from '../../components/Navigation';

/*
  The permission matrix (2026-10-19, the owner's call: "remove the override
  permission, instead create a table check box for all list of role and
  permission — Permission View (VIEW OWN / VIEW TEAM / VIEW ALL) and
  PERMISSION CREATE/EDIT (MANAGE OWN / MANAGE TEAM / MANAGE ALL)"). Every
  screen is a row, every role a column; a cell is the role's View level and
  Manage level on that screen. `lib/permissionLevels.ts` turns the two levels
  into the keys the routes check; Save sends the changed roles' whole sets to
  `PUT /roles/matrix` in one go. There are no per-person exceptions: a
  person's access is their roles' columns.
*/

export interface MatrixRole {
  id: string;
  key: string;
  name: string;
  rank: number | null;
  createdById: string | null;
  permissions: string[];
}

export interface MatrixCatalog {
  modules: {
    key: string;
    label: string;
    submodules: { key: string; label: string; note?: string; own?: string; actions: { action: string; key: string }[] }[];
  }[];
}

/** One screen's key prefix and the actions it has. */
interface Screen {
  module: string;
  moduleLabel: string;
  prefix: string;
  label: string;
  hint?: string;
  actions: string[];
}

function screensOf(catalog: MatrixCatalog): Screen[] {
  return catalog.modules.flatMap((m) =>
    m.submodules.map((s) => ({
      module: m.key,
      moduleLabel: m.label,
      prefix: `${m.key}.${s.key}`,
      label: s.label,
      hint: [s.note, s.own ? `Own here means ${s.own}` : null].filter(Boolean).join(' — ') || undefined,
      actions: s.actions.map((a) => a.action),
    })),
  );
}

/** A role's held actions on one screen. */
function heldOn(keys: ReadonlySet<string>, screen: Screen): Set<string> {
  return new Set(screen.actions.filter((a) => keys.has(`${screen.prefix}.${a}`)));
}

/** The role's keys with one screen's rights set to these two levels. */
function withLevels(keys: ReadonlySet<string>, screen: Screen, view: Level, manage: Level): Set<string> {
  const next = new Set([...keys].filter((k) => !k.startsWith(`${screen.prefix}.`) || !screen.actions.includes(k.slice(screen.prefix.length + 1))));
  for (const a of actionsFor(screen.actions, view, manage)) next.add(`${screen.prefix}.${a}`);
  return next;
}

/** The two selects of one cell. */
function LevelCell({
  screen,
  keys,
  disabled,
  label,
  onChange,
}: {
  screen: Screen;
  keys: ReadonlySet<string>;
  disabled: boolean;
  label: string;
  onChange: (view: Level, manage: Level) => void;
}) {
  const opts = levelOptions(screen.actions);
  const { view, manage } = levelsOf(screen.actions, heldOn(keys, screen));
  return (
    <div className="pm-cell">
      <select
        className={`pm-select pm-${view}`}
        aria-label={`${label} — ${screen.label}: View`}
        value={view}
        disabled={disabled || opts.view.length < 2}
        onChange={(e) => onChange(e.target.value as Level, manage)}
      >
        {opts.view.map((l) => (
          <option key={l} value={l}>
            {LEVEL_LABELS[l]}
          </option>
        ))}
      </select>
      <select
        className={`pm-select pm-${manage}`}
        aria-label={`${label} — ${screen.label}: Manage`}
        value={manage}
        disabled={disabled || opts.manage.length < 2}
        onChange={(e) => onChange(view, e.target.value as Level)}
      >
        {opts.manage.map((l) => (
          <option key={l} value={l}>
            {LEVEL_LABELS[l]}
          </option>
        ))}
      </select>
    </div>
  );
}

/** Rows of screens, a column per role. Used whole on Admin › Roles and with one role in the role editor. */
export function LevelsTable({
  catalog,
  roles,
  keysOf,
  canChange,
  onChange,
  moduleKey,
  search,
}: {
  catalog: MatrixCatalog;
  roles: { id: string; name: string; rank: number | null }[];
  keysOf: (roleId: string) => ReadonlySet<string>;
  canChange: (roleId: string) => boolean;
  onChange: (roleId: string, next: Set<string>) => void;
  moduleKey?: string;
  search?: string;
}) {
  const screens = useMemo(() => screensOf(catalog), [catalog]);
  const term = (search ?? '').trim().toLowerCase();
  const shown = screens.filter((s) => (!moduleKey || s.module === moduleKey) && (!term || s.label.toLowerCase().includes(term)));
  const modules = [...new Set(shown.map((s) => s.module))];
  return (
    <div className="pm-scroll">
      <table className="data pm-table">
        <thead>
          <tr>
            <th className="pm-screen" rowSpan={2}>
              Screen
            </th>
            {roles.map((r) => (
              <th key={r.id} className="pm-role" scope="col">
                <div>{r.name}</div>
                <div className="faint pm-role-level">{r.rank != null ? `Level ${r.rank}` : 'No level'}</div>
              </th>
            ))}
          </tr>
          <tr>
            {roles.map((r) => (
              <th key={r.id} className="pm-axes">
                <span>View</span>
                <span>Manage</span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {modules.map((m) => (
            <ModuleRows
              key={m}
              screens={shown.filter((s) => s.module === m)}
              roles={roles}
              keysOf={keysOf}
              canChange={canChange}
              onChange={onChange}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ModuleRows({
  screens,
  roles,
  keysOf,
  canChange,
  onChange,
}: {
  screens: Screen[];
  roles: { id: string; name: string }[];
  keysOf: (roleId: string) => ReadonlySet<string>;
  canChange: (roleId: string) => boolean;
  onChange: (roleId: string, next: Set<string>) => void;
}) {
  return (
    <>
      <tr className="pm-module">
        <th className="pm-screen" scope="rowgroup">
          {screens[0].moduleLabel}
        </th>
        <td colSpan={roles.length} />
      </tr>
      {screens.map((s) => (
        <tr key={s.prefix}>
          <th className="pm-screen" scope="row" title={s.hint}>
            {s.label}
          </th>
          {roles.map((r) => (
            <td key={r.id}>
              <LevelCell
                screen={s}
                keys={keysOf(r.id)}
                disabled={!canChange(r.id)}
                label={r.name}
                onChange={(view, manage) => onChange(r.id, withLevels(keysOf(r.id), s, view, manage))}
              />
            </td>
          ))}
        </tr>
      ))}
    </>
  );
}

/** Admin › Roles' matrix: every role at once, saved together. */
export function PermissionMatrix({
  roles,
  catalog,
  onSaved,
}: {
  roles: MatrixRole[];
  catalog: MatrixCatalog;
  onSaved: () => void;
}) {
  const { can, me } = useAuth();
  const toast = useToast();
  const [edits, setEdits] = useState<Map<string, Set<string>>>(new Map());
  const [moduleKey, setModuleKey] = useState('');
  const [search, setSearch] = useState('');
  const ordered = useMemo(() => rolesByLevel(roles).flatMap((l) => l.roles), [roles]);
  const [shownIds, setShownIds] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const byId = useMemo(() => new Map(roles.map((r) => [r.id, r])), [roles]);
  const keysOf = (id: string) => edits.get(id) ?? new Set(byId.get(id)?.permissions ?? []);
  // Manage All on roles edits any; Manage Own the roles one made and holds none of (the API decides).
  const canChange = (id: string) => {
    const r = byId.get(id);
    if (!r) return false;
    if (can('admin.roles.edit_all')) return true;
    return mayEdit(can, 'admin', 'roles', !!me && r.createdById === me.user.id) && !(me?.user.roles ?? []).includes(r.key);
  };
  const changed = [...edits.entries()].filter(([id, keys]) => {
    const was = new Set(byId.get(id)?.permissions ?? []);
    return keys.size !== was.size || [...keys].some((k) => !was.has(k));
  });
  const columns = shownIds.length ? ordered.filter((r) => shownIds.includes(r.id)) : ordered;
  // Leaving with unsaved ticks asks first (rule 19).
  useUnsavedChanges(changed.length > 0);

  async function save() {
    setBusy(true);
    setError(null);
    try {
      await api.put('/roles/matrix', { roles: changed.map(([id, keys]) => ({ id, permissions: [...keys] })) });
      toast('ok', `${changed.length} role${changed.length === 1 ? '' : 's'} saved`);
      setEdits(new Map());
      onSaved();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card">
      <div className="card-head">
        <h3 className="card-title">Permission matrix</h3>
        <div className="row">
          {changed.length > 0 && <span className="faint">{changed.length} role{changed.length === 1 ? '' : 's'} changed</span>}
          <button type="button" className="btn btn-sm" disabled={!changed.length || busy} onClick={() => setEdits(new Map())}>
            Discard
          </button>
          <button type="button" className="btn btn-sm btn-primary" disabled={!changed.length || busy} onClick={() => void save()}>
            {busy ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
      <p className="muted">
        Each cell is what the role may <strong>View</strong> and <strong>Manage</strong> (create and edit) on the screen:{' '}
        <strong>Own</strong> — the records the person made or that are theirs; <strong>Team</strong> — their team's (KAT,
        HIT …); <strong>All</strong> — everyone's. A level includes the ones under it. Manage also deletes where the screen
        deletes, View All exports and prints its reports, and Manage All approves where the screen approves.
      </p>
      <ErrorBox error={error} />
      <div className="grid grid-3 pm-tools">
        <Field label="Division">
          <select value={moduleKey} onChange={(e) => setModuleKey(e.target.value)}>
            <option value="">All divisions</option>
            {catalog.modules.map((m) => (
              <option key={m.key} value={m.key}>
                {m.label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Roles shown">
          <TickPicker
            choices={ordered.map((r) => ({ value: r.id, label: r.name, hint: levelLabel(r.rank) }))}
            value={shownIds}
            onChange={setShownIds}
            none="Every role"
            noun="roles"
          />
        </Field>
        <Field label="Find a screen">
          <input type="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Quotations, Leave…" />
        </Field>
      </div>
      <LevelsTable
        catalog={catalog}
        roles={columns}
        keysOf={keysOf}
        canChange={canChange}
        onChange={(id, next) => setEdits((m) => new Map(m).set(id, next))}
        moduleKey={moduleKey || undefined}
        search={search}
      />
    </div>
  );
}
