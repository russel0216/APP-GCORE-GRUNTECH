import { useCallback, useEffect, useState } from 'react';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { ErrorBox, Field, Loading, Modal, useToast } from '../../components/ui';

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
            + Add role
          </button>
        )}
      </div>

      <ErrorBox error={error} />

      <div className="grid grid-3">
        {roles.map((role) => (
          <div
            key={role.id}
            className="card"
            style={{ cursor: 'pointer' }}
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
          </div>
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

  async function remove() {
    if (!role) return;
    setBusy(true);
    try {
      await api.del(`/roles/${role.id}`);
      toast('ok', `${role.name} deleted`);
      onSaved();
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  }

  return (
    <Modal
      wide
      title={role ? `Modify ${role.name}` : 'Add role'}
      onClose={onClose}
      footer={
        <>
          {role && !role.isSystem && can('admin.roles.delete') && (
            <button className="btn btn-danger" onClick={remove} disabled={busy}>
              Delete
            </button>
          )}
          <div style={{ flex: 1 }} />
          <button className="btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button className="btn btn-primary" onClick={save} disabled={busy}>
            {busy ? 'Saving…' : `Save (${selected.size})`}
          </button>
        </>
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
              onClick={() =>
                setCollapsed((c) => {
                  const next = new Set(c);
                  if (next.has(mod.key)) next.delete(mod.key);
                  else next.add(mod.key);
                  return next;
                })
              }
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
                      style={{ cursor: 'pointer' }}
                      onClick={() => toggleSubmodule(subKeys)}
                      title={sub.note}
                    >
                      {sub.label}
                      {sub.phase > 1 && (
                        <span className="tag" style={{ marginLeft: 6 }}>
                          P{sub.phase}
                        </span>
                      )}
                    </div>
                    <div className="perm-actions">
                      {sub.actions.map((a) => (
                        <span
                          key={a.key}
                          className={`perm-chip${selected.has(a.key) ? ' on' : ''}`}
                          onClick={() => toggle(a.key)}
                          title={a.key}
                        >
                          {a.label}
                        </span>
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
