import { useCallback, useEffect, useState, type KeyboardEvent } from 'react';
import { api } from '../../lib/api';
import { mayEdit, useAuth } from '../../lib/auth';
import { ErrorBox, Field, Loading, Modal, ModalFoot, useToast } from '../../components/ui';
import { levelLabel, rolesByLevel } from '../../lib/roleLevels';

interface Role {
  id: string;
  key: string;
  name: string;
  description: string | null;
  /** Its level on the chart (1 the CEO … 6 the skilled trades): a person's title is their highest role. */
  rank: number | null;
  isSystem: boolean;
  /** Who made it — Edit Own reads it (2026-10-18). */
  createdById: string | null;
  userCount: number;
  permissions: string[];
}

interface Catalog {
  total: number;
  modules: {
    key: string;
    label: string;
    blurb: string;
    submodules: {
      key: string;
      label: string;
      phase: number;
      note?: string;
      /** What View Own and Edit Own mean on this screen (2026-10-18). */
      own?: string;
      actions: { action: string; label: string; key: string }[];
    }[];
  }[];
}

export function Roles() {
  const { can } = useAuth();
  const [roles, setRoles] = useState<Role[]>([]);
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [editing, setEditing] = useState<Role | 'new' | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [r, c] = await Promise.all([
        api.get<Role[]>('/roles'),
        api.get<Catalog>('/roles/permission-catalog'),
      ]);
      setRoles(r);
      setCatalog(c);
      setError(null);
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading) return <Loading />;

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Roles &amp; Permissions</h1>
          <p>
            Permissions read <span className="mono">module.submodule.action</span>. A screen only
            appears in someone's menu if they hold a view permission for it, so the menu and the
            access can never drift apart.
          </p>
        </div>
        {can('admin.roles.create') && (
          <button className="btn btn-primary" onClick={() => setEditing('new')}>
            + New role
          </button>
        )}
      </div>

      <ErrorBox error={error} />

      {/* The role hierarchy (2026-10-19): the roles under their level, top first. */}
      <div className="stack">
      {rolesByLevel(roles).map((level) => (
      <section key={level.label} className="role-level">
      <h2 className="role-level-head">{level.label}</h2>
      <div className="grid grid-3">
        {level.roles.map((role) => (
          // A button, not a div: opening a role to modify it was mouse-only (rule 13).
          <button
            type="button"
            key={role.id}
            className="card clickable card-button"
            onClick={() => setEditing(role)}
          >
            <div className="row" style={{ justifyContent: 'space-between' }}>
              <strong>{role.name}</strong>
              {role.isSystem && <span className="badge">system</span>}
            </div>
            <div className="muted" style={{ fontSize: 'var(--fs-sm)', margin: 'var(--s-2) 0 var(--s-3)', minHeight: '2rem' }}>
              {role.description}
            </div>
            <div className="faint mono" style={{ fontSize: 'var(--fs-xs)' }}>
              {role.permissions.length} permissions · {role.userCount} user
              {role.userCount === 1 ? '' : 's'}
            </div>
          </button>
        ))}
      </div>
      </section>
      ))}
      </div>

      {editing && catalog && (
        <RoleEditor
          role={editing === 'new' ? null : editing}
          catalog={catalog}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            void load();
          }}
        />
      )}
    </div>
  );
}

function RoleEditor({
  role,
  catalog,
  onClose,
  onSaved,
}: {
  role: Role | null;
  catalog: Catalog;
  onClose: () => void;
  onSaved: () => void;
}) {
  const toast = useToast();
  const { can, me } = useAuth();
  // A new role is the create right's; an existing one Edit All's, or Edit
  // Own's on a role the viewer made (2026-10-18). The API decides for real.
  const maySave = role ? mayEdit(can, 'admin', 'roles', !!me && role.createdById === me.user.id) : can('admin.roles.create');
  const [name, setName] = useState(role?.name ?? '');
  const [key, setKey] = useState(role?.key ?? '');
  const [description, setDescription] = useState(role?.description ?? '');
  const [rank, setRank] = useState(role?.rank != null ? String(role.rank) : '');
  const [selected, setSelected] = useState<Set<string>>(new Set(role?.permissions ?? []));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  function toggle(permissionKey: string) {
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(permissionKey)) next.delete(permissionKey);
      else next.add(permissionKey);
      return next;
    });
  }

  function toggleModule(moduleKey: string) {
    setCollapsed((c) => {
      const next = new Set(c);
      if (next.has(moduleKey)) next.delete(moduleKey);
      else next.add(moduleKey);
      return next;
    });
  }

  function toggleSubmodule(keys: string[]) {
    const allOn = keys.every((k) => selected.has(k));
    setSelected((s) => {
      const next = new Set(s);
      for (const k of keys) {
        if (allOn) next.delete(k);
        else next.add(k);
      }
      return next;
    });
  }

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const payload = { key, name, description: description || null, rank: rank ? Number(rank) : null, permissions: [...selected] };
      if (role) await api.put(`/roles/${role.id}`, payload);
      else await api.post('/roles', payload);
      toast('ok', `${name} saved`);
      onSaved();
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  }

  /** Asked in the modal's foot first; a refusal is shown there, so it throws. */
  async function remove() {
    if (!role) return;
    await api.del(`/roles/${role.id}`);
    toast('ok', `${role.name} deleted`);
    onSaved();
  }

  return (
    <Modal
      wide
      title={role ? `Modify role ${role.name}` : 'New role'}
      onClose={onClose}
      footer={
        <ModalFoot
          onCancel={onClose}
          busy={busy}
          danger={
            role && !role.isSystem && can('admin.roles.delete')
              ? {
                  label: 'Delete',
                  question: `Delete the role ${role.name}?${
                    role.userCount ? ` It is taken off the ${role.userCount} ${role.userCount === 1 ? 'person' : 'people'} who hold it.` : ''
                  } It cannot be undone.`,
                  onConfirm: remove,
                }
              : undefined
          }
        >
          {maySave && (
            <button className="btn btn-primary" onClick={save} disabled={busy}>
              {busy ? 'Saving…' : 'Save'}
            </button>
          )}
        </ModalFoot>
      }
    >
      <ErrorBox error={error} />
      {role?.isSystem && can('admin.roles.delete') && (
        <p className="faint">A built-in role cannot be deleted — remove its permissions or take it off people instead. Roles you made can be deleted here.</p>
      )}
      {role && !role.isSystem && can('admin.roles.delete') && (
        <p className="faint">A role an approval route still names (a step, or Prepared by) is refused — change the route in Admin › Approval Workflows first.</p>
      )}

      <div className="grid grid-2">
        <Field label="Role name">
          <input value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field
          label="Key"
          hint="Lowercase, no spaces. Used by approval workflows. These keys carry a rule of their own, whatever the role is named: team_leader, technical_manager, sales_manager, service_manager (Aftermarket Manager), back_support, finance and credit_collection (Checking), purchasing_manager, purchasing_manager_import, hr, ceo, warehouse_supervisor. A role holding one of them cannot be deleted."
        >
          <input
            value={key}
            disabled={!!role}
            onChange={(e) => setKey(e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, '_'))}
          />
        </Field>
      </div>
      <div className="grid grid-2">
        <Field label="Description">
          <input value={description} onChange={(e) => setDescription(e.target.value)} />
        </Field>
        <Field
          label="Level on the chart"
          hint="Where the role sits in the hierarchy. A person's title on documents is their highest role."
        >
          <select value={rank} onChange={(e) => setRank(e.target.value)}>
            <option value="">— none —</option>
            {[1, 2, 3, 4, 5, 6].map((n) => (
              <option key={n} value={n}>
                {levelLabel(n)}
              </option>
            ))}
          </select>
        </Field>
      </div>

      <hr className="rule" />

      <div className="row" style={{ justifyContent: 'space-between', marginBottom: 'var(--s-3)' }}>
        <strong>Permissions</strong>
        <span className="faint" style={{ fontSize: 'var(--fs-sm)' }}>
          {selected.size} of {catalog.total} · click a screen name to toggle all its actions
        </span>
      </div>

      {catalog.modules.map((mod) => {
        const isCollapsed = collapsed.has(mod.key);
        const modKeys = mod.submodules.flatMap((s) => s.actions.map((a) => a.key));
        const on = modKeys.filter((k) => selected.has(k)).length;
        return (
          <div key={mod.key} className="perm-module">
            <header
              role="button"
              tabIndex={0}
              aria-expanded={!isCollapsed}
              onClick={() => toggleModule(mod.key)}
              onKeyDown={onActivate(() => toggleModule(mod.key))}
            >
              <h4>
                {isCollapsed ? '▸' : '▾'} {mod.label}
              </h4>
              <span className="faint mono" style={{ fontSize: 'var(--fs-xs)' }}>
                {on}/{modKeys.length}
              </span>
            </header>

            {!isCollapsed &&
              mod.submodules.map((sub) => {
                const subKeys = sub.actions.map((a) => a.key);
                return (
                  <div key={sub.key} className="perm-row">
                    <div
                      className="name"
                      role="button"
                      tabIndex={0}
                      style={{ cursor: 'pointer' }}
                      onClick={(e) => {
                        toggleSubmodule(subKeys);
                        markChanged(e.currentTarget);
                      }}
                      onKeyDown={onActivate((el) => {
                        toggleSubmodule(subKeys);
                        markChanged(el);
                      })}
                      title={sub.note}
                    >
                      {sub.label}
                    </div>
                    <div className="perm-actions">
                      {sub.actions.map((a) => (
                        // A button, not a span: a permission could not be ticked from a keyboard (rule 13).
                        <button
                          type="button"
                          key={a.key}
                          className={`perm-chip${selected.has(a.key) ? ' on' : ''}`}
                          aria-pressed={selected.has(a.key)}
                          onClick={(e) => {
                            toggle(a.key);
                            markChanged(e.currentTarget);
                          }}
                          title={sub.own && (a.action === 'view_own' || a.action === 'edit_own') ? `${a.key} — Own here means ${sub.own}` : a.key}
                        >
                          {a.label}
                        </button>
                      ))}
                    </div>
                  </div>
                );
              })}
          </div>
        );
      })}
    </Modal>
  );
}

/** Enter or Space on something drawn as a button but not one. */
function onActivate(fn: (el: HTMLElement) => void) {
  return (e: KeyboardEvent<HTMLElement>) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      fn(e.currentTarget);
    }
  };
}

/**
 * A permission is ticked with a button, and a button sends no `input` event —
 * so the Modal's "Close without saving?" guard never heard about it, and
 * Escape or a click outside threw the ticks away. Tell it, the way a field
 * would. (Collapsing a module changes nothing, so it does not.)
 */
function markChanged(el: HTMLElement) {
  el.dispatchEvent(new Event('input', { bubbles: true }));
}
