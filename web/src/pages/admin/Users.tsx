import { useEffect, useState } from 'react';
import { Link, useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api } from '../../lib/api';
import { mayEdit, useAuth } from '../../lib/auth';
import { DataList, type Column } from '../../components/DataList';
import { Stat } from '../../components/charts';
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
import { PeopleTree } from './PeopleTree';
import { rolesByLevel } from '../../lib/roleLevels';
import { NewPersonModal } from '../masters/Employees';
import { PersonSelect, usePeople } from '../../components/People';

/** Roles whose approval step goes by the teams a holder supports — `TEAM_SCOPED_ROLES` in shared/approvals.ts. */
const TEAM_SCOPED_ROLES = ['back_support'];

interface Role {
  id: string;
  key: string;
  name: string;
  /** Its level on the chart (1 the CEO / President) — the Access tab lists roles under it. */
  rank?: number | null;
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
  supervisor: { id: string; name: string } | null;
  /** The team on their employee record (`Employee.industryId`). */
  team?: { code: string; name: string } | null;
  /** Their employee record, when the login has one — the person (2026-10-16). */
  employeeId?: string | null;
  /** The main plantilla post and the others held (2026-10-19). */
  mainPosition?: string | null;
  alsoHolds?: string[];
  /** The title on documents: the highest of the roles (ROLE_REV1, 2026-10-19). */
  title?: string | null;
}

/** The halves of a person still apart (GET /users summary, 2026-10-16). */
interface UsersSummary {
  loginsAlone: number;
  employeesAlone: number;
  /** Active logins with no employee number yet (2026-10-18). */
  withoutNumber: number;
  /** Logins holding more than six roles — listed, never trimmed (2026-10-19). */
  moreThanMaxRoles?: number;
  maxRoles?: number;
}

/** The single-user endpoint returns role ids (the list only needs key + name). */
type UserDetail = Omit<UserRow, 'roles'> & {
  roles: { id: string; key: string; name: string }[];
  /** The teams they support on a team-scoped approval step (Back Support). */
  supportTeams: { industryId: string }[];
  /** The invitation in flight, while it is pending. */
  invite: { sentAt: string; expiresAt: string; live: boolean } | null;
  employee: {
    id: string;
    employeeNo: string;
    firstName: string;
    lastName: string;
    suffix: string | null;
    industryId: string | null;
  } | null;
};

interface MailStatus {
  enabled: boolean;
  host: string | null;
  from: string | null;
}

/** A person holds six roles at most (the owner's call, 2026-10-19; the API refuses a seventh). */
const MAX_ROLES = 6;

const BASE = '/admin/users';

export function Users() {
  const { can } = useAuth();
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const location = useLocation();
  // ?view=tree shows the organisational chart and ?view=hierarchy the people
  // tree; it is in the URL so the view stays behind a person opened from it,
  // and a link can open it directly.
  const [params, setParams] = useSearchParams();
  const view = params.get('view') === 'tree' ? 'tree' : params.get('view') === 'hierarchy' ? 'hierarchy' : 'list';
  const showView = (next: 'list' | 'tree' | 'hierarchy') => {
    const p = new URLSearchParams(params);
    if (next !== 'list') p.set('view', next);
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

  useEffect(() => {
    api.get<Role[]>('/roles').then(setRoles).catch(() => setRoles([]));
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
          <div className="faint">{u.title ?? u.position ?? '—'}</div>
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
          <button
            type="button"
            className={view === 'hierarchy' ? 'active' : ''}
            aria-pressed={view === 'hierarchy'}
            onClick={() => showView('hierarchy')}
          >
            Hierarchy
          </button>
          <button type="button" className={view === 'tree' ? 'active' : ''} aria-pressed={view === 'tree'} onClick={() => showView('tree')}>
            Organizational Chart
          </button>
        </div>
      </div>

      {view === 'tree' ? (
        <OrgChart key={reload} />
      ) : view === 'hierarchy' ? (
        <PeopleTree key={reload} />
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
          {
            key: 'linked',
            label: 'Employee record',
            options: [
              { value: 'no', label: 'No employee record' },
              { value: 'yes', label: 'Linked to an employee' },
            ],
          },
          {
            key: 'number',
            label: 'Employee number',
            options: [
              { value: 'none', label: 'No employee number yet' },
              { value: 'yes', label: 'Has an employee number' },
            ],
          },
        ]}
        summary={(raw) => {
          const sum = raw as unknown as UsersSummary | undefined;
          if (!sum) return null;
          return (
            <>
              <Stat
                label="Logins with no employee"
                value={sum.loginsAlone}
                accent={sum.loginsAlone > 0 ? 'warn' : undefined}
                sub="open one and link it, or add the person in HR › Employees"
                to={`${BASE}?linked=no`}
              />
              <Stat
                label="Employees with no login"
                value={sum.employeesAlone}
                accent={sum.employeesAlone > 0 ? 'warn' : undefined}
                sub="active people who cannot sign in yet"
                to="/g-hr/employees?login=none&isActive=true"
              />
              <Stat
                label="Without an employee number"
                value={sum.withoutNumber}
                accent={sum.withoutNumber > 0 ? 'warn' : undefined}
                sub="type it on the login (GTC-0001-14) — no quotation number is issued without one"
                to={`${BASE}?number=none`}
              />
              {!!sum.moreThanMaxRoles && (
                <Stat
                  label={`More than ${MAX_ROLES} roles`}
                  value={sum.moreThanMaxRoles}
                  accent="warn"
                  sub={`a person holds ${MAX_ROLES} roles at most — their next save needs it trimmed`}
                  to={`${BASE}?roles=over`}
                />
              )}
            </>
          );
        }}
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
 * Modify of an existing account — details and roles.
 * It makes nobody: a person is created with their login through
 * `NewPersonModal` (2026-10-10), never as a login alone.
 */
function UserEditor({
  id,
  roles,
  onClose,
  onSaved,
}: {
  id: string;
  roles: Role[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const toast = useToast();
  /*
    Edit Own on Admin › Users is the viewer's own login, and only its plain
    details (2026-10-18): roles, Supports teams, Reports to, the
    team, the employee number, Active and a password stay Edit All's — the
    API refuses them (403) and the form neither offers nor sends them.
  */
  const { can, me } = useAuth();
  const full = can('admin.users.edit_all');
  const maySave = mayEdit(can, 'admin', 'users', !!me && me.user.id === id);
  const [tab, setTab] = useState<'details' | 'access'>('details');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  // The one people fetch (components/People.tsx, rule 20).
  const { people } = usePeople();

  const [form, setForm] = useState({
    name: '',
    /** The employee record's name parts, for a linked login (2026-10-19). */
    firstName: '',
    lastName: '',
    suffix: '',
    email: '',
    password: '',
    employeeNo: '',
    position: '',
    phone: '',
    supervisorId: '',
    roleIds: [] as string[],
    supportTeamIds: [] as string[],
    teamId: '',
    isActive: true,
  });
  const [teams, setTeams] = useState<{ id: string; code: string; name: string; isActive: boolean }[]>([]);
  const [detail, setDetail] = useState<UserDetail | null>(null);
  /**
   * A login with an employee record mirrors it (2026-10-16): its name,
   * position and mobile are the record's — typed here since
   * 2026-10-19 and written through to the record, which the login follows.
   */
  const kept = !!detail?.employee;
  /** The link just issued — shown until the administrator is done with it. */
  const [issued, setIssued] = useState<{ delivery: Delivery; kind: 'invite' | 'reset' } | null>(null);

  useEffect(() => {
    api
      .get<{ id: string; code: string; name: string; isActive: boolean }[]>('/reference/industries')
      .then(setTeams)
      .catch(() => setTeams([]));
  }, []);

  useEffect(() => {
    api
      .get<UserDetail>(`/users/${id}`)
      .then((u) => {
        setDetail(u);
        setForm({
          name: u.name,
          firstName: u.employee?.firstName ?? '',
          lastName: u.employee?.lastName ?? '',
          suffix: u.employee?.suffix ?? '',
          email: u.email,
          password: '',
          employeeNo: u.employeeNo ?? '',
          position: u.mainPosition ?? u.position ?? '',
          phone: u.phone ?? '',
          supervisorId: u.supervisor?.id ?? '',
          roleIds: u.roles.map((r) => r.id),
          supportTeamIds: (u.supportTeams ?? []).map((t) => t.industryId),
          teamId: u.employee?.industryId ?? '',
          isActive: u.isActive,
        });
      })
      .catch(setError);
  }, [id]);

  async function save() {
    setBusy(true);
    setError(null);
    try {
      // A linked login's details are written through to the employee record.
      const details = {
        ...(kept
          ? { firstName: form.firstName.trim(), lastName: form.lastName.trim(), suffix: form.suffix.trim() || null }
          : { name: form.name }),
        // Sent only when changed: the login's title joins every post held.
        phone: form.phone || null,
      };
      // Edit Own: their own plain details, nothing else (2026-10-18).
      if (!full) {
        await api.patch(`/users/${id}`, details);
        toast('ok', `${kept ? `${form.firstName} ${form.lastName}`.trim() : form.name} updated`);
        onSaved();
        return;
      }
      const payload = {
        // Written through to the employee record when there is one, as the
        // employee number and the Team are; the login follows the record.
        employeeNo: form.employeeNo || null,
        ...details,
        supervisorId: form.supervisorId || null,
        roleIds: form.roleIds,
        supportTeamIds: form.supportTeamIds,
        ...(detail?.employee ? { teamId: form.teamId || null } : {}),
        isActive: form.isActive,
        ...(form.password ? { password: form.password } : {}),
      };

      await api.patch(`/users/${id}`, payload);

      toast('ok', `${kept ? `${form.firstName} ${form.lastName}`.trim() : form.name} updated`);
      onSaved();
    } catch (err) {
      setError(err);
      setBusy(false);
    }
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
        <ModalFoot onCancel={onClose} busy={busy} cancelLabel={maySave ? undefined : 'Close'}>
          {maySave && (
            <button className="btn btn-primary" onClick={save} disabled={busy}>
              {busy ? 'Saving…' : 'Save'}
            </button>
          )}
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
          {detail?.employee && (
            <div className="alert info">
              This login is {detail.employee.firstName} {detail.employee.lastName}'s — the name, employee number
              and mobile typed here are saved onto their{' '}
              <Link to={`/g-hr/employees/${detail.employee.id}`}>employee record ↗</Link>, and the login follows it.
            </div>
          )}
          <div className="grid grid-2">
            {kept ? (
              <>
                <Field label="First name">
                  <input value={form.firstName} onChange={(e) => setForm({ ...form, firstName: e.target.value })} />
                </Field>
                <Field label="Last name">
                  <input value={form.lastName} onChange={(e) => setForm({ ...form, lastName: e.target.value })} />
                </Field>
              </>
            ) : (
              <Field label="Full name">
                <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
              </Field>
            )}
            <Field label="Email" hint="The address they sign in with — it stays">
              <input type="email" value={form.email} disabled />
            </Field>
            <Field
              label="Employee number"
              hint="GTC-0001-14: the person's sequence, then the year hired. The {EMP} in their quotation numbers is the sequence (001)."
            >
              <input
                className="mono"
                value={form.employeeNo}
                placeholder="GTC-0001-14"
                disabled={!full}
                onChange={(e) => setForm({ ...form, employeeNo: e.target.value })}
              />
            </Field>
            {kept && (
              <Field label="Suffix" hint="Jr., Sr., III — leave blank if none">
                <input value={form.suffix} onChange={(e) => setForm({ ...form, suffix: e.target.value })} />
              </Field>
            )}
            <Field label="Title" hint="Their highest role (Access tab) — what documents print">
              <input readOnly value={detail?.position ?? ''} placeholder="— no role yet —" />
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
              <PersonSelect
                disabled={!full}
                value={form.supervisorId}
                onChange={(pid) => setForm({ ...form, supervisorId: pid })}
                people={people.filter((p) => p.id !== id)}
                current={detail?.supervisor ?? null}
              />
            </Field>
            <Field
              label="Team"
              hint={
                detail?.employee
                  ? 'Their quotations, leads and sales orders count under this team — the team cards, the Team view and the forecast — and a Technical Manager or Team Leader approves for their own team. Team Leaders, Technical Managers and sales need one.'
                  : 'This login has no employee record, so it cannot keep a team — add one in HR › Employees.'
              }
            >
              <select
                value={form.teamId}
                disabled={!detail?.employee || !full}
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
            {full && (
              <Field label="New password" htmlFor="user-password" hint="Leave blank to keep the current password">
                <PasswordInput
                  id="user-password"
                  value={form.password}
                  autoComplete="new-password"
                  onChange={(e) => setForm({ ...form, password: e.target.value })}
                />
              </Field>
            )}
          </div>

          {detail && (
            <SignInPanel
              detail={detail}
              issued={issued}
              busy={busy}
              onIssue={(kind) => void issue(kind)}
            />
          )}

          {full && (
            <Checkbox
              checked={form.isActive}
              onChange={(v) => setForm({ ...form, isActive: v })}
              label="Active — inactive users cannot sign in and drop out of approval routing"
            />
          )}
        </>
      ) : (
        <>
          {!full && (
            <div className="alert info">
              Roles and Supports teams are changed by an administrator with Manage All on Users.
            </div>
          )}
          <Field
            label={`Roles — ${form.roleIds.length}`}
            hint="Roles are the whole of a person's access. The highest is their title on documents."
          >
            <div className="role-levels">
              {rolesByLevel(roles).map((level) => (
                <div key={level.label} className="role-level">
                  <div className="role-level-head">{level.label}</div>
                  <div className="row">
              {level.roles.map((r) => (
                <label key={r.id} className="checkbox">
                  <input
                    type="checkbox"
                    checked={form.roleIds.includes(r.id)}
                    disabled={!full}
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
                </div>
              ))}
            </div>
          </Field>

          {roles.some((r) => TEAM_SCOPED_ROLES.includes(r.key) && form.roleIds.includes(r.id)) && (
            <Field
              label="Supports teams (Back Support)"
              hint="Where they support in back admin: a Back Support approval goes to whoever supports the preparer's team, whoever their own manager is. None ticked: their own Team (Details)."
            >
              <div className="row">
                {teams
                  .filter((t) => t.isActive || form.supportTeamIds.includes(t.id))
                  .map((t) => (
                    <label key={t.id} className="checkbox">
                      <input
                        type="checkbox"
                        checked={form.supportTeamIds.includes(t.id)}
                        disabled={!full}
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

          <p className="faint">
            What each role may see and change is set on <Link to="/admin/roles">Admin › Roles</Link> — the permission
            matrix. There are no per-person exceptions (2026-10-19): give the person a role instead.
          </p>
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
          {detail.isActive && can('admin.users.edit_all') && (
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
