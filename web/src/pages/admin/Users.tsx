import { useEffect, useState } from 'react';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { DataList, type Column } from '../../components/DataList';
import {
  Checkbox,
  ErrorBox,
  Field,
  Modal,
  formatDateTime,
  useToast,
} from '../../components/ui';

interface Role {
  id: string;
  key: string;
  name: string;
}
interface Department {
  id: string;
  name: string;
}
interface UserRow {
  id: string;
  name: string;
  email: string;
  employeeNo: string | null;
  position: string | null;
  isActive: boolean;
  isSuperAdmin: boolean;
  lastLoginAt: string | null;
  roles: { key: string; name: string }[];
  department: { id: string; name: string } | null;
  supervisor: { id: string; name: string } | null;
}

/** The single-user endpoint returns role ids (the list only needs key + name). */
type UserDetail = Omit<UserRow, 'roles'> & {
  roles: { id: string; key: string; name: string }[];
  overrides: { key: string; effect: 'ALLOW' | 'DENY' }[];
};

interface PermissionCatalog {
  modules: {
    key: string;
    label: string;
    blurb: string;
    submodules: {
      key: string;
      label: string;
      phase: number;
      actions: { action: string; label: string; key: string }[];
    }[];
  }[];
}

export function Users() {
  const { can } = useAuth();
  const [editing, setEditing] = useState<string | 'new' | null>(null);
  const [reload, setReload] = useState(0);
  const [roles, setRoles] = useState<Role[]>([]);
  const [departments, setDepartments] = useState<Department[]>([]);

  useEffect(() => {
    api.get<Role[]>('/roles').then(setRoles).catch(() => setRoles([]));
    api.get<Department[]>('/departments').then(setDepartments).catch(() => setDepartments([]));
  }, []);

  const columns: Column<UserRow>[] = [
    {
      key: 'name',
      label: 'Name',
      sortKey: 'name',
      render: (u) => (
        <div>
          <div>
            {u.name}
            {u.isSuperAdmin && (
              <span className="badge info" style={{ marginLeft: 7 }}>
                Super Admin
              </span>
            )}
          </div>
          <div className="faint">{u.position ?? '—'}</div>
        </div>
      ),
    },
    { key: 'email', label: 'Email', sortKey: 'email', render: (u) => <span className="mono">{u.email}</span> },
    { key: 'employeeNo', label: 'Employee No.', sortKey: 'employeeNo', render: (u) => u.employeeNo ?? '—', optional: true },
    {
      key: 'roles',
      label: 'Roles',
      render: (u) =>
        u.roles.length === 0 ? (
          <span className="faint">none</span>
        ) : (
          <div className="row" style={{ gap: 4 }}>
            {u.roles.map((r) => (
              <span key={r.key} className="badge">
                {r.name}
              </span>
            ))}
          </div>
        ),
    },
    { key: 'department', label: 'Department', render: (u) => u.department?.name ?? '—' },
    { key: 'supervisor', label: 'Reports to', render: (u) => u.supervisor?.name ?? '—' },
    {
      key: 'isActive',
      label: 'Status',
      render: (u) => (
        <span className={`badge ${u.isActive ? 'ok' : 'danger'}`}>{u.isActive ? 'Active' : 'Inactive'}</span>
      ),
    },
    {
      key: 'lastLoginAt',
      label: 'Last sign-in',
      sortKey: 'lastLoginAt',
      render: (u) => <span className="muted">{formatDateTime(u.lastLoginAt)}</span>,
      optional: true,
    },
  ];

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Users</h1>
          <p>
            Access is granted by role, then adjusted per person. A denial on an individual always
            beats a grant from their role, so you can hand out a broad role and still close one door.
          </p>
        </div>
      </div>

      <DataList<UserRow>
        listKey="admin-users"
        endpoint="/users"
        columns={columns}
        rowKey={(u) => u.id}
        searchPlaceholder="Search name, email, employee no…"
        reloadToken={reload}
        onRowClick={(u) => setEditing(u.id)}
        emptyTitle="No users match"
        filters={[
          {
            key: 'isActive',
            label: 'Status',
            options: [
              { value: 'true', label: 'Active' },
              { value: 'false', label: 'Inactive' },
            ],
          },
          { key: 'role', label: 'Role', options: roles.map((r) => ({ value: r.key, label: r.name })) },
        ]}
        actions={
          can('admin.users.create') ? (
            <button className="btn btn-primary btn-sm" onClick={() => setEditing('new')}>
              + Add user
            </button>
          ) : null
        }
      />

      {editing && (
        <UserEditor
          id={editing}
          roles={roles}
          departments={departments}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            setReload((r) => r + 1);
          }}
        />
      )}
    </div>
  );
}

function UserEditor({
  id,
  roles,
  departments,
  onClose,
  onSaved,
}: {
  id: string | 'new';
  roles: Role[];
  departments: Department[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const isNew = id === 'new';
  const toast = useToast();
  const [tab, setTab] = useState<'details' | 'access'>('details');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [people, setPeople] = useState<UserRow[]>([]);
  const [catalog, setCatalog] = useState<PermissionCatalog | null>(null);
  const [overrides, setOverrides] = useState<Record<string, 'ALLOW' | 'DENY'>>({});

  const [form, setForm] = useState({
    name: '',
    email: '',
    password: '',
    employeeNo: '',
    position: '',
    supervisorId: '',
    departmentId: '',
    roleIds: [] as string[],
    isActive: true,
  });

  useEffect(() => {
    api
      .get<{ rows: UserRow[] }>('/users?pageSize=200')
      .then((r) => setPeople(r.rows))
      .catch(() => setPeople([]));
    api
      .get<PermissionCatalog>('/roles/permission-catalog')
      .then(setCatalog)
      .catch(() => setCatalog(null));
  }, []);

  useEffect(() => {
    if (isNew) return;
    api
      .get<UserDetail>(`/users/${id}`)
      .then((u) => {
        setForm({
          name: u.name,
          email: u.email,
          password: '',
          employeeNo: u.employeeNo ?? '',
          position: u.position ?? '',
          supervisorId: u.supervisor?.id ?? '',
          departmentId: u.department?.id ?? '',
          roleIds: u.roles.map((r) => r.id),
          isActive: u.isActive,
        });
        setOverrides(Object.fromEntries(u.overrides.map((o) => [o.key, o.effect])));
      })
      .catch(setError);
  }, [id, isNew]);

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const payload = {
        name: form.name,
        employeeNo: form.employeeNo || null,
        position: form.position || null,
        supervisorId: form.supervisorId || null,
        departmentId: form.departmentId || null,
        roleIds: form.roleIds,
        isActive: form.isActive,
        ...(form.password ? { password: form.password } : {}),
      };

      const userId = isNew
        ? (await api.post<{ id: string }>('/users', { ...payload, email: form.email, password: form.password })).id
        : id;

      await api.put(`/users/${userId}/overrides`, {
        overrides: Object.entries(overrides).map(([key, effect]) => ({ key, effect })),
      });

      if (!isNew) await api.patch(`/users/${id}`, payload);

      toast('ok', isNew ? `${form.name} added` : `${form.name} updated`);
      onSaved();
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  }

  function cycle(key: string) {
    setOverrides((o) => {
      const next = { ...o };
      if (!next[key]) next[key] = 'ALLOW';
      else if (next[key] === 'ALLOW') next[key] = 'DENY';
      else delete next[key];
      return next;
    });
  }

  return (
    <Modal
      wide
      title={isNew ? 'Add user' : `Modify ${form.name || 'user'}`}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button className="btn btn-primary" onClick={save} disabled={busy}>
            {busy ? 'Saving…' : 'Save'}
          </button>
        </>
      }
    >
      <ErrorBox error={error} />

      <div className="row" style={{ marginBottom: 16 }}>
        <div className="scope-switch">
          <button className={tab === 'details' ? 'active' : ''} onClick={() => setTab('details')}>
            Details
          </button>
          <button className={tab === 'access' ? 'active' : ''} onClick={() => setTab('access')}>
            Access
          </button>
        </div>
      </div>

      {tab === 'details' ? (
        <>
          <div className="grid grid-2">
            <Field label="Full name">
              <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
            </Field>
            <Field label="Email">
              <input
                type="email"
                value={form.email}
                disabled={!isNew}
                onChange={(e) => setForm({ ...form, email: e.target.value })}
              />
            </Field>
            <Field label="Employee number">
              <input
                value={form.employeeNo}
                onChange={(e) => setForm({ ...form, employeeNo: e.target.value })}
              />
            </Field>
            <Field label="Position">
              <input
                value={form.position}
                onChange={(e) => setForm({ ...form, position: e.target.value })}
              />
            </Field>
            <Field
              label="Reports to"
              hint="Used by every approval step that routes to the supervisor. With none set, those steps fall through to HR."
            >
              <select
                value={form.supervisorId}
                onChange={(e) => setForm({ ...form, supervisorId: e.target.value })}
              >
                <option value="">— none —</option>
                {people
                  .filter((p) => p.id !== id)
                  .map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
              </select>
            </Field>
            <Field label="Department">
              <select
                value={form.departmentId}
                onChange={(e) => setForm({ ...form, departmentId: e.target.value })}
              >
                <option value="">— none —</option>
                {departments.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field
              label={isNew ? 'Password' : 'New password'}
              hint={isNew ? 'At least 8 characters' : 'Leave blank to keep the current password'}
            >
              <input
                type="password"
                value={form.password}
                autoComplete="new-password"
                onChange={(e) => setForm({ ...form, password: e.target.value })}
              />
            </Field>
          </div>

          <Checkbox
            checked={form.isActive}
            onChange={(v) => setForm({ ...form, isActive: v })}
            label="Active — inactive users cannot sign in and drop out of approval routing"
          />
        </>
      ) : (
        <>
          <Field label="Roles" hint="Roles grant the bulk of access. Adjust individual screens below.">
            <div className="row">
              {roles.map((r) => (
                <label key={r.id} className="checkbox">
                  <input
                    type="checkbox"
                    checked={form.roleIds.includes(r.id)}
                    onChange={(e) =>
                      setForm({
                        ...form,
                        roleIds: e.target.checked
                          ? [...form.roleIds, r.id]
                          : form.roleIds.filter((x) => x !== r.id),
                      })
                    }
                  />
                  <span>{r.name}</span>
                </label>
              ))}
            </div>
          </Field>

          <hr className="rule" />

          <div className="row" style={{ justifyContent: 'space-between', marginBottom: 10 }}>
            <strong>Per-person overrides</strong>
            <span className="faint" style={{ fontSize: 12 }}>
              click to cycle: role default → <span style={{ color: 'var(--neon)' }}>allow</span> →{' '}
              <span style={{ color: 'var(--danger)' }}>deny</span>
            </span>
          </div>

          {!catalog ? (
            <div className="muted">Loading the permission catalog…</div>
          ) : (
            catalog.modules.map((mod) => (
              <div key={mod.key} className="perm-module">
                <header>
                  <h4>{mod.label}</h4>
                  <span className="faint" style={{ fontSize: 12 }}>
                    {mod.blurb}
                  </span>
                </header>
                {mod.submodules.map((sub) => (
                  <div key={sub.key} className="perm-row">
                    <div className="name">
                      {sub.label}
                      {sub.phase > 1 && <span className="tag" style={{ marginLeft: 6 }}>P{sub.phase}</span>}
                    </div>
                    <div className="perm-actions">
                      {sub.actions.map((a) => {
                        const state = overrides[a.key];
                        return (
                          <span
                            key={a.key}
                            className={`perm-chip${state === 'ALLOW' ? ' on' : state === 'DENY' ? ' deny' : ''}`}
                            onClick={() => cycle(a.key)}
                            title={a.key}
                          >
                            {a.label}
                          </span>
                        );
                      })}
                    </div>
                  </div>
                ))}
              </div>
            ))
          )}
        </>
      )}
    </Modal>
  );
}
