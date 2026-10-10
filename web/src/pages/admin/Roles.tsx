import { useCallback, useEffect, useState, type KeyboardEvent } from 'react';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { ErrorBox, Field, Loading, Modal, ModalFoot, useToast } from '../../components/ui';

interface Role {
  id: string;
  key: string;
  name: string;
  description: string | null;
  isSystem: boolean;
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

      <div className="grid grid-3">
        {roles.map((role) => (
          // A button, not a div: opening a role to modify it was mouse-only (rule 13).
          // A column, so the card's text starts at its top as it did, not centred as a button centres it.
          <button
            type="button"
            key={role.id}
            className="card clickable card-button"
            style={{ display: 'flex', flexDirection: 'column', justifyContent: 'flex-start' }}
            onClick={() => setEditing(role)}
          >
            <div className="row" style={{ justifyContent: 'space-between' }}>
              <strong>{role.name}</strong>
              {role.isSystem && <span className="badge">system</span>}
            </div>
            <div className="muted" style={{ fontSize: 12, margin: '6px 0 10px', minHeight: 32 }}>
              {role.description}
            </div>
            <div className="faint mono" style={{ fontSize: 11 }}>
              {role.permissions.length} permissions · {role.userCount} user
              {role.userCount === 1 ? '' : 's'}
            </div>
          </button>
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
  const { can } = useAuth();
  const [name, setName] = useState(role?.name ?? '');
  const [key, setKey] = useState(role?.key ?? '');
  const [description, setDescription] = useState(role?.description ?? '');
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
      const payload = { key, name, description: description || null, permissions: [...selected] };
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
                  question: `Delete the role ${role.name}? It cannot be undone.`,
                  onConfirm: remove,
                }
              : undefined
          }
        >
          <button className="btn btn-primary" onClick={save} disabled={busy}>
            {busy ? 'Saving…' : 'Save'}
          </button>
        </ModalFoot>
      }
    >
      <ErrorBox error={error} />

      <div className="grid grid-2">
        <Field label="Role name">
          <input value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="Key" hint="Lowercase, no spaces. Used by approval workflows.">
          <input
            value={key}
            disabled={!!role}
            onChange={(e) => setKey(e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, '_'))}
          />
        </Field>
      </div>
      <Field label="Description">
        <input value={description} onChange={(e) => setDescription(e.target.value)} />
      </Field>

      <hr className="rule" />

      <div className="row" style={{ justifyContent: 'space-between', marginBottom: 10 }}>
        <strong>Permissions</strong>
        <span className="faint" style={{ fontSize: 12 }}>
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
              <span className="faint mono" style={{ fontSize: 11 }}>
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
                          title={a.key}
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
