import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api } from '../../lib/api';
import { mayEdit, useAuth } from '../../lib/auth';
import { ErrorBox, Field, Loading, Modal, ModalFoot, useToast } from '../../components/ui';
import { levelLabel, rolesByLevel } from '../../lib/roleLevels';
import { LevelsTable, PermissionMatrix } from './PermissionMatrix';
import { RoleHierarchy } from './RoleHierarchy';

interface Role {
  id: string;
  key: string;
  name: string;
  description: string | null;
  /** Its level on the chart (1 the CEO … 6 the skilled trades): a person's title is their highest role. */
  rank: number | null;
  /** The role it reports to (Hierarchy). */
  reportsToRoleId: string | null;
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
  // ?view=roles shows the role cards; the matrix is the page (2026-10-19).
  const [params, setParams] = useSearchParams();
  const v = params.get('view');
  const view = v === 'roles' || v === 'hierarchy' ? v : 'matrix';
  const showView = (next: 'matrix' | 'roles' | 'hierarchy') => {
    const p = new URLSearchParams(params);
    if (next !== 'matrix') p.set('view', next);
    else p.delete('view');
    setParams(p, { replace: true });
  };

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
            A person's access is their roles' — View and Manage, each Own, Team or All, per screen. A screen
            appears in someone's menu only when a role of theirs may view it.
          </p>
        </div>
        {can('admin.roles.create') && (
          <button className="btn btn-primary" onClick={() => setEditing('new')}>
            + New role
          </button>
        )}
      </div>

      <ErrorBox error={error} />

      <div className="row org-switch">
        <div className="scope-switch">
          <button type="button" className={view === 'matrix' ? 'active' : ''} aria-pressed={view === 'matrix'} onClick={() => showView('matrix')}>
            Permission matrix
          </button>
          <button type="button" className={view === 'roles' ? 'active' : ''} aria-pressed={view === 'roles'} onClick={() => showView('roles')}>
            Roles
          </button>
          <button type="button" className={view === 'hierarchy' ? 'active' : ''} aria-pressed={view === 'hierarchy'} onClick={() => showView('hierarchy')}>
            Hierarchy
          </button>
        </div>
      </div>

      {view === 'hierarchy' && <RoleHierarchy key={roles.map((r) => r.reportsToRoleId).join()} roles={roles} onSaved={() => void load()} />}

      {view === 'matrix' && catalog && <PermissionMatrix roles={roles} catalog={catalog} onSaved={() => void load()} />}

      {/* The role hierarchy (2026-10-19): the roles under their level, top first. */}
      {view === 'roles' && (
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
      )}

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
  // A select inside the table is a field, so the Modal's guard hears a change on its own.
  const [find, setFind] = useState('');

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

      <Field label="What this role may do" hint="View and Manage (create and edit), each Own, Team or All, on every screen — the same as its column in the permission matrix.">
        <input type="search" value={find} onChange={(e) => setFind(e.target.value)} placeholder="Find a screen…" />
      </Field>
      <LevelsTable
        catalog={catalog}
        roles={[{ id: 'this', name: name || 'This role', rank: rank ? Number(rank) : null }]}
        keysOf={() => selected}
        canChange={() => maySave}
        onChange={(_id, next) => setSelected(next)}
        search={find}
      />
    </Modal>
  );
}
