import { useEffect, useState } from 'react';
import { Link, useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { DataList, type Column } from '../../components/DataList';
import {
  Checkbox,
  ErrorBox,
  Field,
  Modal,
  ModalFoot,
  StatusBadge,
  formatDateTime,
  useToast,
} from '../../components/ui';
import { PasswordInput } from '../../components/PasswordInput';
import { LinkDelivery, type Delivery } from '../../components/LinkDelivery';
import { OrgChart } from './OrgChart';
import { NewPersonModal } from '../masters/Employees';

/** Roles whose approval step goes by the teams a holder supports — `TEAM_SCOPED_ROLES` in shared/approvals.ts. */
const TEAM_SCOPED_ROLES = ['back_support'];

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
  phone: string | null;
  isActive: boolean;
  isSuperAdmin: boolean;
  /** Invited, and has not chosen a password yet. */
  invitePending: boolean;
  lastLoginAt: string | null;
  roles: { key: string; name: string }[];
  department: { id: string; name: string } | null;
  supervisor: { id: string; name: string } | null;
  /** The team on their employee record (`Employee.industryId`). */
  team?: { code: string; name: string } | null;
}

/** The single-user endpoint returns role ids (the list only needs key + name). */
type UserDetail = Omit<UserRow, 'roles'> & {
  roles: { id: string; key: string; name: string }[];
  overrides: { key: string; effect: 'ALLOW' | 'DENY' }[];
  /** The teams they support on a team-scoped approval step (Back Support). */
  supportTeams: { industryId: string }[];
  /** The invitation in flight, while it is pending. */
  invite: { sentAt: string; expiresAt: string; live: boolean } | null;
  employee: { id: string; employeeNo: string; firstName: string; lastName: string; industryId: string | null } | null;
};

/**
 * A permission chip is a button, and a button sends no `input` event — so the
 * Modal's "Close without saving?" guard never heard about a tick. Tell it, the
 * way a field would.
 */
function markChanged(el: HTMLElement) {
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

interface MailStatus {
  enabled: boolean;
  host: string | null;
  from: string | null;
}

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

const BASE = '/admin/users';

export function Users() {
  const { can } = useAuth();
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const location = useLocation();
  // ?view=tree shows the organisational chart; it is in the URL so the chart
  // stays behind a person opened from it, and a link can open it directly.
  const [params, setParams] = useSearchParams();
  const view = params.get('view') === 'tree' ? 'tree' : 'list';
  const showView = (next: 'list' | 'tree') => {
    const p = new URLSearchParams(params);
    if (next === 'tree') p.set('view', 'tree');
    else p.delete('view');
    setParams(p, { replace: true });
  };
  // Adding someone is a local modal; an existing person has a URL, so a search
  // hit or a link from an employee record opens their editor directly.
  const [adding, setAdding] = useState(false);
  /*
    "+ New user" is the one creation form (2026-10-10, the owner's call:
    "unite the creation of user and HR employee record"): a new person with
    their login, or a login for an employee HR already registered. The
    button shows when the viewer can do either; the form hides the branch
    they cannot.
  */
  const mayAdd = can('admin.users.create') && (can('ghr.employees.create') || can('ghr.employees.edit_all'));
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
              <span className="badge info hraud-inline-gap">
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
          <div className="row hraud-tight">
            {u.roles.map((r) => (
              <span key={r.key} className="badge">
                {r.name}
              </span>
            ))}
          </div>
        ),
    },
    { key: 'department', label: 'Department', render: (u) => u.department?.name ?? '—' },
    { key: 'team', label: 'Team', render: (u) => (u.team ? <span title={u.team.name}>{u.team.code}</span> : '—') },
    { key: 'supervisor', label: 'Reports to', render: (u) => u.supervisor?.name ?? '—' },
    {
      key: 'isActive',
      label: 'Status',
      render: (u) =>
        // Invited: the account exists, its person has not chosen a password yet.
        u.isActive && u.invitePending ? (
          <StatusBadge status="INVITED" extra={{ INVITED: 'warn' }} />
        ) : (
          <StatusBadge status={u.isActive ? 'ACTIVE' : 'INACTIVE'} extra={{ INACTIVE: 'danger' }} />
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

  function close() {
    navigate(`${BASE}${location.search}`);
  }

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Users</h1>
        </div>
      </div>

      <MailLine />

      <div className="row org-switch">
        <div className="scope-switch">
          <button type="button" className={view === 'list' ? 'active' : ''} aria-pressed={view === 'list'} onClick={() => showView('list')}>
            Users
          </button>
          <button type="button" className={view === 'tree' ? 'active' : ''} aria-pressed={view === 'tree'} onClick={() => showView('tree')}>
            Organizational Chart
          </button>
        </div>
      </div>

      {view === 'tree' ? (
        <OrgChart key={reload} />
      ) : (
      <DataList<UserRow>
        listKey="admin-users"
        endpoint="/users"
        printPath="/api/users/pdf"
        columns={columns}
        rowKey={(u) => u.id}
        searchPlaceholder="Search name, email, employee no…"
        reloadToken={reload}
        onRowClick={(u) => navigate(`${BASE}/${u.id}${location.search}`)}
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
          mayAdd ? (
            <button className="btn btn-primary btn-sm" onClick={() => setAdding(true)}>
              + New user
            </button>
          ) : null
        }
      />
      )}

      {adding && (
        <NewPersonModal
          door="admin"
          onClose={() => setAdding(false)}
          onSaved={() => {
            setAdding(false);
            setReload((r) => r + 1);
          }}
        />
      )}

      {id && (
        <UserEditor
          key={id}
          id={id}
          roles={roles}
          departments={departments}
          onClose={close}
          onSaved={() => {
            close();
            setReload((r) => r + 1);
          }}
        />
      )}
    </div>
  );
}

/**
 * Modify of an existing account — details, roles and per-person overrides.
 * It makes nobody: a person is created with their login through
 * `NewPersonModal` (2026-10-10), never as a login alone.
 */
function UserEditor({
  id,
  roles,
  departments,
  onClose,
  onSaved,
}: {
  id: string;
  roles: Role[];
  departments: Department[];
  onClose: () => void;
  onSaved: () => void;
}) {
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
    phone: '',
    supervisorId: '',
    departmentId: '',
    roleIds: [] as string[],
    supportTeamIds: [] as string[],
    teamId: '',
    isActive: true,
  });
  const [teams, setTeams] = useState<{ id: string; code: string; name: string; isActive: boolean }[]>([]);
  const [detail, setDetail] = useState<UserDetail | null>(null);
  /** The link just issued — shown until the administrator is done with it. */
  const [issued, setIssued] = useState<{ delivery: Delivery; kind: 'invite' | 'reset' } | null>(null);

  useEffect(() => {
    api
      .get<{ rows: UserRow[] }>('/users?pageSize=200')
      .then((r) => setPeople(r.rows))
      .catch(() => setPeople([]));
    api
      .get<{ id: string; code: string; name: string; isActive: boolean }[]>('/reference/industries')
      .then(setTeams)
      .catch(() => setTeams([]));
    api
      .get<PermissionCatalog>('/roles/permission-catalog')
      .then(setCatalog)
      .catch(() => setCatalog(null));
  }, []);

  useEffect(() => {
    api
      .get<UserDetail>(`/users/${id}`)
      .then((u) => {
        setDetail(u);
        setForm({
          name: u.name,
          email: u.email,
          password: '',
          employeeNo: u.employeeNo ?? '',
          position: u.position ?? '',
          phone: u.phone ?? '',
          supervisorId: u.supervisor?.id ?? '',
          departmentId: u.department?.id ?? '',
          roleIds: u.roles.map((r) => r.id),
          supportTeamIds: (u.supportTeams ?? []).map((t) => t.industryId),
          teamId: u.employee?.industryId ?? '',
          isActive: u.isActive,
        });
        setOverrides(Object.fromEntries(u.overrides.map((o) => [o.key, o.effect])));
      })
      .catch(setError);
  }, [id]);

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const payload = {
        name: form.name,
        employeeNo: form.employeeNo || null,
        position: form.position || null,
        phone: form.phone || null,
        supervisorId: form.supervisorId || null,
        departmentId: form.departmentId || null,
        roleIds: form.roleIds,
        supportTeamIds: form.supportTeamIds,
        ...(detail?.employee ? { teamId: form.teamId || null } : {}),
        isActive: form.isActive,
        ...(form.password ? { password: form.password } : {}),
      };

      await api.put(`/users/${id}/overrides`, {
        overrides: Object.entries(overrides).map(([key, effect]) => ({ key, effect })),
      });
      await api.patch(`/users/${id}`, payload);

      toast('ok', `${form.name} updated`);
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

  async function issue(kind: 'invite' | 'reset') {
    setBusy(true);
    setError(null);
    try {
      const delivery = await api.post<Delivery>(`/users/${id}/${kind === 'invite' ? 'invite' : 'reset-link'}`);
      setIssued({ delivery, kind });
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      wide
      title={`Modify user ${detail?.name ?? form.name}`.trim()}
      onClose={onClose}
      footer={
        <ModalFoot onCancel={onClose} busy={busy}>
          <button className="btn btn-primary" onClick={save} disabled={busy}>
            {busy ? 'Saving…' : 'Save'}
          </button>
        </ModalFoot>
      }
    >
      <ErrorBox error={error} />

      <div className="row hraud-below">
        <div className="scope-switch">
          <button
            type="button"
            className={tab === 'details' ? 'active' : ''}
            aria-pressed={tab === 'details'}
            onClick={() => setTab('details')}
          >
            Details
          </button>
          <button
            type="button"
            className={tab === 'access' ? 'active' : ''}
            aria-pressed={tab === 'access'}
            onClick={() => setTab('access')}
          >
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
            <Field label="Email" hint="The address they sign in with — it stays">
              <input type="email" value={form.email} disabled />
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
            <Field label="Mobile" hint="Printed under the author's name on the quotations they raise">
              <input
                type="tel"
                autoComplete="off"
                value={form.phone}
                onChange={(e) => setForm({ ...form, phone: e.target.value })}
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
              label="Team"
              hint={
                detail?.employee
                  ? 'Their quotations, leads and sales orders count under this team — the team cards, the Team view and the forecast. Team Leaders and sales need one.'
                  : 'This login has no employee record, so it cannot keep a team — add one in HR › Employees.'
              }
            >
              <select
                value={form.teamId}
                disabled={!detail?.employee}
                onChange={(e) => setForm({ ...form, teamId: e.target.value })}
              >
                <option value="">— no team —</option>
                {teams
                  .filter((t) => t.isActive || t.id === form.teamId)
                  .map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.code} — {t.name}
                    </option>
                  ))}
              </select>
            </Field>
            <Field label="New password" htmlFor="user-password" hint="Leave blank to keep the current password">
              <PasswordInput
                id="user-password"
                value={form.password}
                autoComplete="new-password"
                onChange={(e) => setForm({ ...form, password: e.target.value })}
              />
            </Field>
          </div>

          {detail && (
            <SignInPanel
              detail={detail}
              issued={issued}
              busy={busy}
              onIssue={(kind) => void issue(kind)}
            />
          )}

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

          {roles.some((r) => TEAM_SCOPED_ROLES.includes(r.key) && form.roleIds.includes(r.id)) && (
            <Field
              label="Supports teams (Back Support)"
              hint="Where they support in back admin: a Back Support approval goes to whoever supports the preparer's team, whoever their own manager is. None ticked supports every team."
            >
              <div className="row">
                {teams
                  .filter((t) => t.isActive || form.supportTeamIds.includes(t.id))
                  .map((t) => (
                    <label key={t.id} className="checkbox">
                      <input
                        type="checkbox"
                        checked={form.supportTeamIds.includes(t.id)}
                        onChange={(e) =>
                          setForm({
                            ...form,
                            supportTeamIds: e.target.checked
                              ? [...form.supportTeamIds, t.id]
                              : form.supportTeamIds.filter((x) => x !== t.id),
                          })
                        }
                      />
                      <span title={t.name}>{t.code}</span>
                    </label>
                  ))}
              </div>
            </Field>
          )}

          <hr className="rule" />

          <div className="row hraud-spread hraud-below">
            <strong>Per-person overrides</strong>
            <span className="faint hraud-small">
              click to cycle: role default → <span className="hraud-allow">allow</span> →{' '}
              <span className="hraud-deny">deny</span> — a deny beats a grant from any role
            </span>
          </div>

          {!catalog ? (
            <div className="muted">Loading the permission catalog…</div>
          ) : (
            catalog.modules.map((mod) => (
              <div key={mod.key} className="perm-module">
                <header>
                  <h4>{mod.label}</h4>
                  <span className="faint hraud-small">{mod.blurb}</span>
                </header>
                {mod.submodules.map((sub) => (
                  <div key={sub.key} className="perm-row">
                    <div className="name">
                      {sub.label}
                    </div>
                    <div className="perm-actions">
                      {sub.actions.map((a) => {
                        const state = overrides[a.key];
                        // A button, not a span: the chips were mouse-only, so an
                        // override could not be set from a keyboard (rule 13).
                        return (
                          <button
                            type="button"
                            key={a.key}
                            className={`perm-chip${state === 'ALLOW' ? ' on' : state === 'DENY' ? ' deny' : ''}`}
                            onClick={(e) => {
                              cycle(a.key);
                              markChanged(e.currentTarget);
                            }}
                            title={a.key}
                            aria-label={`${sub.label}: ${a.label} — ${
                              state === 'ALLOW' ? 'allowed' : state === 'DENY' ? 'denied' : 'role default'
                            }`}
                          >
                            {a.label}
                          </button>
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

/**
 * Where an existing account stands on signing in, and the two links an
 * administrator can send: a new invitation while it is pending, a password
 * reset once it is in use.
 */
function SignInPanel({
  detail,
  issued,
  busy,
  onIssue,
}: {
  detail: UserDetail;
  issued: { delivery: Delivery; kind: 'invite' | 'reset' } | null;
  busy: boolean;
  onIssue: (kind: 'invite' | 'reset') => void;
}) {
  const { can } = useAuth();
  return (
    <div className="signin-panel">
      <h4>Signing in</h4>
      {detail.employee && (
        <p className="muted">
          Employee record:{' '}
          {can('ghr.employees.view_all') ? (
            <Link to={`/g-hr/employees/${detail.employee.id}`}>
              {detail.employee.firstName} {detail.employee.lastName} · {detail.employee.employeeNo}
            </Link>
          ) : (
            `${detail.employee.firstName} ${detail.employee.lastName} · ${detail.employee.employeeNo}`
          )}
        </p>
      )}
      {detail.invitePending ? (
        <>
          <p>
            Invited — they have not chosen a password yet.
            {detail.invite && (
              <>
                {' '}
                Sent {formatDateTime(detail.invite.sentAt)};{' '}
                {detail.invite.live ? `works until ${formatDateTime(detail.invite.expiresAt)}.` : 'it has run out.'}
              </>
            )}
          </p>
          {can('admin.users.create') && detail.isActive && (
            <button type="button" className="btn btn-sm" disabled={busy} onClick={() => onIssue('invite')}>
              Send a new invitation
            </button>
          )}
        </>
      ) : (
        <>
          <p className="muted">
            {detail.lastLoginAt ? `Last signed in ${formatDateTime(detail.lastLoginAt)}.` : 'Has not signed in yet.'} If
            they are locked out, send them a link to choose a new password.
          </p>
          {detail.isActive && (
            <button type="button" className="btn btn-sm" disabled={busy} onClick={() => onIssue('reset')}>
              Send a password reset link
            </button>
          )}
        </>
      )}
      {issued && <LinkDelivery delivery={issued.delivery} email={detail.email} kind={issued.kind} />}
    </div>
  );
}

/**
 * Whether invitations and resets go by email, and a test — so a wrong mailbox
 * password shows up now, on the administrator's own inbox, rather than on the
 * first person invited.
 */
function MailLine() {
  const { can } = useAuth();
  const toast = useToast();
  const [status, setStatus] = useState<MailStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    api.get<MailStatus>('/users/mail-status').then(setStatus).catch(() => setStatus(null));
  }, []);

  async function test() {
    setBusy(true);
    setError(null);
    try {
      const r = await api.post<{ to: string }>('/users/mail-test');
      toast('ok', `Test email sent to ${r.to} — check the inbox`);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  if (!status) return null;
  return (
    <div className={`alert ${status.enabled ? 'ok' : 'info'} mail-line`}>
      <ErrorBox error={error} />
      {status.enabled ? (
        <div className="row mail-line-row">
          <span>
            Invitations and password resets are emailed from <span className="mono">{status.from}</span>.
          </span>
          {can('admin.users.edit_all') && (
            <button type="button" className="btn btn-sm" disabled={busy} onClick={() => void test()}>
              {busy ? 'Sending…' : 'Send me a test email'}
            </button>
          )}
        </div>
      ) : (
        <span>
          Email is not set up yet: when you invite someone or reset a password, G-CORE gives you the link to send
          them yourself. Add the mailbox settings on the server to have it emailed.
        </span>
      )}
    </div>
  );
}
