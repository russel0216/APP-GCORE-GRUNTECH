import { useEffect, useId, useState } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import { api, ApiError } from '../../lib/api';
import { useAuth, mayView } from '../../lib/auth';
import { DataList, type Column } from '../../components/DataList';
import { ImportModal, loadImportSpec } from '../../components/ImportModal';
import { ActiveBadge, Checkbox, ErrorBox, Field, Loading, Modal, ModalFoot, formatDate, formatMoney, useToast } from '../../components/ui';
import { PasswordInput } from '../../components/PasswordInput';
import { LinkDelivery, type Delivery } from '../../components/LinkDelivery';
import { EmployeeEvaluationsTab } from '../hr/EmployeeEvaluationsTab';
import { EmployeeFlowTab } from '../hr/PeopleFlow';
import { NumberInput } from '../../components/NumberInput';
import { PersonSelect, usePeople, type PersonRow } from '../../components/People';
import { FaceSamplesPanel } from '../hr/FaceSamples';
import { Stat } from '../../components/charts';

const EMPLOYMENT_TYPES = [
  { value: 'REGULAR', label: 'Regular' },
  { value: 'PROBATIONARY', label: 'Probationary' },
  { value: 'TRAINEE', label: 'Trainee' },
  { value: 'PROJECT_BASED', label: 'Project-based' },
  { value: 'CONTRACTUAL', label: 'Contractual' },
  { value: 'PART_TIME', label: 'Part-time' },
];

/** GET /positions/lookup — the plantilla, for the picker and the filter. */
interface PositionOption {
  id: string;
  code: string;
  title: string;
  /** The level of the role the position counts (2026-10-19). */
  level: number | null;
  authorisedHeadcount: number;
  filled: number;
}

/** GET /reference/industries — the teams a person can be on. */
interface TeamOption {
  id: string;
  code: string;
  name: string;
  isActive: boolean;
}

interface EmployeeRow {
  id: string;
  employeeNo: string | null;
  firstName: string;
  lastName: string;
  middleName: string | null;
  suffix: string | null;
  /**
   * The title. For an employee on a plantilla position this is a MIRROR of
   * positionRef.title written by the server; it is free text only when
   * positionId is null (unclassified).
   */
  position: string | null;
  positionId: string | null;
  positionRef: { id: string; code: string; title: string } | null;
  /** Positions held beside the main one (2026-10-19). */
  extraPositions?: { position: { id: string; code: string; title: string } }[];
  employmentType: string;
  dateHired: string | null;
  dateRegularized: string | null;
  /** When probation or training is due to end — the evaluation clock. */
  periodEndDate: string | null;
  dateSeparated: string | null;
  mobile: string | null;
  personalEmail: string | null;
  address: string | null;
  birthDate: string | null;
  emergencyContactName: string | null;
  emergencyContactPhone: string | null;
  isActive: boolean;
  notes: string | null;
  /** The industry team they work in — an Industry row. */
  industry: { id: string; code: string; name: string } | null;
  user: {
    id: string;
    email: string;
    isActive: boolean;
    /** Invited, and has not chosen a password yet. */
    invitePending?: boolean;
    supervisor?: { id: string; name: string } | null;
  } | null;
  /*
    What the viewer may do with this record, from `GET /employees/:id`
    (2026-10-18): Modify (Edit All, or Edit Own on their own record), and
    the pay fields — read and changed with the rates' View/Edit All, or
    View/Edit Own on their own record alone.
  */
  canEdit?: boolean;
  canSeeRates?: boolean;
  canEditRates?: boolean;
  // Only present when the caller may see this record's pay data
  // (ghr.employee_rates.view_all, or view_own on their own record)
  dailyRate?: number | null;
  burdenMultiplier?: number | null;
  sssNo?: string | null;
  philhealthNo?: string | null;
  pagibigNo?: string | null;
  tin?: string | null;
}

export function Employees() {
  const { can } = useAuth();
  // The open record is the URL: /g-hr/employees/:id. A plantilla holder link,
  // a leaver on the turnover report or a clearance lands on the person, not on
  // the list with nothing selected.
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const location = useLocation();
  const [creating, setCreating] = useState(false);
  const [record, setRecord] = useState<EmployeeRow | null>(null);
  const [recordError, setRecordError] = useState<unknown>(null);
  const [importing, setImporting] = useState<{ label: string; columns: never[] } | null>(null);
  const [reload, setReload] = useState(0);
  const [teams, setTeams] = useState<TeamOption[]>([]);
  const [positions, setPositions] = useState<PositionOption[]>([]);

  // The pay columns: View All fills every row, View Own the viewer's own
  // (2026-10-18) — the API strips every other row's rates.
  const seeRates = mayView(can, 'ghr', 'employee_rates');
  const seeUsers = can('admin.users.view_all');

  useEffect(() => {
    // Every industry, switched-off ones included: a record may still carry one.
    api.get<TeamOption[]>('/reference/industries').then(setTeams).catch(() => {});
  }, []);

  useEffect(() => {
    api.get<PositionOption[]>('/positions/lookup').then(setPositions).catch(() => {});
  }, [reload]);

  useEffect(() => {
    if (!id) {
      setRecord(null);
      setRecordError(null);
      return;
    }
    let live = true;
    setRecordError(null);
    api
      .get<EmployeeRow>(`/employees/${id}`)
      .then((r) => live && setRecord(r))
      .catch((err) => live && setRecordError(err));
    return () => {
      live = false;
    };
  }, [id]);

  // Keep the list's own URL state (search, filters, page) across open/close.
  // `?tab=face&sample=` is a deep link into one record (HR Settings › Face
  // health) and goes when the record closes, so the next one opens plainly.
  const params = new URLSearchParams(location.search);
  const initialTab = params.get('tab') === 'face' ? 'face' : undefined;
  const flaggedSampleId = params.get('sample');
  const listSearch = () => {
    const kept = new URLSearchParams(location.search);
    kept.delete('tab');
    kept.delete('sample');
    const s = kept.toString();
    return s ? `?${s}` : '';
  };
  const openRecord = (e: EmployeeRow) => navigate(`/g-hr/employees/${e.id}${listSearch()}`);
  const closeRecord = () => navigate(`/g-hr/employees${listSearch()}`);

  const columns: Column<EmployeeRow>[] = [
    {
      key: 'employeeNo',
      label: 'Employee No.',
      sortKey: 'employeeNo',
      width: '12rem',
      render: (e) => (e.employeeNo ? <span className="mono">{e.employeeNo}</span> : <span className="faint">none yet</span>),
    },
    {
      key: 'name',
      label: 'Name',
      sortKey: 'lastName',
      render: (e) => (
        <div>
          <div>
            {e.lastName}, {e.firstName} {e.middleName?.[0] ? `${e.middleName[0]}.` : ''}
          </div>
          <div className="faint">
            {e.positionRef?.title ?? e.position ?? '—'}
            {!e.positionId && e.position ? ' · unclassified' : ''}
          </div>
          {!!e.extraPositions?.length && (
            <div className="faint">Also holds: {e.extraPositions.map((x) => x.position.title).join(', ')}</div>
          )}
        </div>
      ),
    },
    { key: 'industry', label: 'Team', render: (e) => e.industry?.name ?? '—' },
    {
      key: 'employmentType',
      label: 'Type',
      render: (e) => (
        <span className="badge">
          {EMPLOYMENT_TYPES.find((t) => t.value === e.employmentType)?.label ?? e.employmentType}
        </span>
      ),
    },
    { key: 'dateHired', label: 'Hired', sortKey: 'dateHired', render: (e) => formatDate(e.dateHired) },
    { key: 'mobile', label: 'Mobile', render: (e) => e.mobile ?? '—', optional: true },
    {
      key: 'account',
      label: 'Login',
      render: (e) =>
        e.user ? (
          seeUsers ? (
            // The login opens the user account; the row around it opens the person.
            <span onClick={(ev) => ev.stopPropagation()} onKeyDown={(ev) => ev.stopPropagation()}>
              <Link to={`/admin/users/${e.user.id}`} className="mono" title={e.user.email}>
                {e.user.email}
              </Link>
              {e.user.invitePending && <span className="faint"> · invited</span>}
            </span>
          ) : (
            <span className="mono" title={e.user.email}>
              {e.user.email}
              {e.user.invitePending && <span className="faint"> · invited</span>}
            </span>
          )
        ) : (
          <span className="faint">none</span>
        ),
      optional: true,
    },
    ...(seeRates
      ? ([
          {
            key: 'dailyRate',
            label: 'Daily rate',
            align: 'right' as const,
            render: (e: EmployeeRow) => (e.dailyRate == null ? '—' : formatMoney(e.dailyRate)),
            optional: true,
          },
          {
            key: 'burdened',
            label: 'Burdened/day',
            align: 'right' as const,
            render: (e: EmployeeRow) =>
              e.dailyRate == null || e.burdenMultiplier == null
                ? '—'
                : formatMoney(e.dailyRate * e.burdenMultiplier),
            optional: true,
          },
        ] as Column<EmployeeRow>[])
      : []),
    {
      key: 'isActive',
      label: 'Status',
      render: (e) => (
        <ActiveBadge active={e.isActive} />
      ),
    },
  ];

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Employees</h1>
        </div>
      </div>

      <DataList<EmployeeRow>
        listKey="employees"
        endpoint="/employees"
        printPath="/api/employees/pdf"
        columns={columns}
        rowKey={(e) => e.id}
        searchPlaceholder="Search name, employee number, position…"
        reloadToken={reload}
        onRowClick={openRecord}
        emptyTitle="No employees yet"
        emptyHint="Add them one at a time, or import your existing list."
        filters={[
          {
            key: 'isActive',
            label: 'Status',
            options: [
              { value: 'true', label: 'Active' },
              { value: 'false', label: 'Inactive' },
            ],
          },
          {
            key: 'industryId',
            label: 'Team',
            options: [{ value: 'none', label: 'No team yet' }, ...teams.map((t) => ({ value: t.id, label: t.name }))],
          },
          { key: 'employmentType', label: 'Type', options: EMPLOYMENT_TYPES },
          {
            key: 'positionId',
            label: 'Position',
            options: [
              { value: 'none', label: 'No plantilla position' },
              ...positions.map((p) => ({
                value: p.id,
                label: p.level != null ? `${p.title} · Level ${p.level}` : p.title,
              })),
            ],
          },
          {
            key: 'login',
            label: 'Login',
            options: [
              { value: 'none', label: 'No login yet' },
              { value: 'yes', label: 'Has a login' },
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
          const sum = raw as unknown as { withoutNumber: number } | undefined;
          if (!sum) return null;
          return (
            <Stat
              label="Without an employee number"
              value={sum.withoutNumber}
              accent={sum.withoutNumber > 0 ? 'warn' : undefined}
              sub="GTC-0001-14 — the sequence, then the year hired; no quotation number is issued without one"
              to="/g-hr/employees?number=none&isActive=true"
            />
          );
        }}
        menuItems={
          can('ghr.employees.create')
            ? [
                {
                  label: 'Import employees…',
                  hint: 'From a spreadsheet, checked before anything is saved',
                  onSelect: () => {
                    void loadImportSpec('employees').then((spec) => {
                      if (spec) setImporting(spec as { label: string; columns: never[] });
                    });
                  },
                },
              ]
            : []
        }
        actions={
          can('ghr.employees.create') ? (
            <button className="btn btn-primary btn-sm" onClick={() => setCreating(true)}>
              + New employee
            </button>
          ) : undefined
        }
      />

      {id && recordError !== null && (
        <Modal title="Employee" onClose={closeRecord} footer={<ModalFoot onCancel={closeRecord} cancelLabel="Close" />}>
          <ErrorBox error={recordError} />
        </Modal>
      )}
      {id && recordError === null && (!record || record.id !== id) && (
        <Modal title="Employee" onClose={closeRecord}>
          <Loading />
        </Modal>
      )}

      {id && record && record.id === id && (
        <EmployeeForm
          key={record.id}
          employee={record}
          initialTab={initialTab}
          flaggedSampleId={flaggedSampleId}
          teams={teams}
          positions={positions}
          onClose={closeRecord}
          onSaved={() => {
            closeRecord();
            setReload((r) => r + 1);
          }}
        />
      )}

      {creating && (
        <NewPersonModal
          door="hr"
          onClose={() => setCreating(false)}
          onSaved={() => {
            setCreating(false);
            setReload((r) => r + 1);
          }}
        />
      )}

      {importing && (
        <ImportModal
          entity="employees"
          label={importing.label}
          columns={importing.columns}
          onClose={() => setImporting(null)}
          onImported={() => setReload((r) => r + 1)}
        />
      )}
    </div>
  );
}

type EmployeeTab = 'person' | 'employment' | 'login' | 'pay' | 'evaluations' | 'face' | 'flow';

/**
 * Which door a new person comes in by (2026-10-10, the owner's call: "unite
 * the creation of user and HR employee record"). Both open the one form and
 * the one save, `POST /employees { login }`:
 *   - `hr`    — HR › Employees "+ New employee": the login is made with the
 *               record when the viewer may make logins, and can be unticked.
 *   - `admin` — Admin › Users "+ New user": the login is the point, so it is
 *               required and the form opens on it; or the login goes to an
 *               employee already on the register (`POST /employees/:id/login`).
 */
export type PersonDoor = 'hr' | 'admin';

/** A login the typed email already belongs to — `details[0].existingLogin` on the server's 409. */
interface ExistingLogin {
  id: string;
  name: string;
  email: string;
  linkable: boolean;
  isActive?: boolean;
  employeeId?: string;
  employeeNo?: string;
}

function existingLoginIn(err: unknown): ExistingLogin | null {
  if (!(err instanceof ApiError) || err.status !== 409) return null;
  const found = (err.details?.[0] as { existingLogin?: ExistingLogin } | undefined)?.existingLogin;
  return found && typeof found.id === 'string' ? found : null;
}

/** An employee on the register with no login yet — `GET /employees/lookup` rows with `!hasUser`. */
interface RegisterOption {
  id: string;
  employeeNo: string;
  firstName: string;
  lastName: string;
  position: string | null;
  industry: { id: string; code: string; name: string } | null;
  hasUser: boolean;
}

/**
 * The one creation form, for either door. It loads the lists the form picks
 * from itself, so Admin › Users needs nothing of the register page.
 */
export function NewPersonModal({ door, onClose, onSaved }: { door: PersonDoor; onClose: () => void; onSaved: () => void }) {
  const [teams, setTeams] = useState<TeamOption[]>([]);
  const [positions, setPositions] = useState<PositionOption[]>([]);
  useEffect(() => {
    api.get<TeamOption[]>('/reference/industries').then(setTeams).catch(() => {});
    // The plantilla is HR's list; an administrator without it types the title.
    api.get<PositionOption[]>('/positions/lookup').then(setPositions).catch(() => {});
  }, []);
  return (
    <EmployeeForm
      employee={null}
      door={door}
      teams={teams}
      positions={positions}
      onClose={onClose}
      onSaved={onSaved}
    />
  );
}

function EmployeeForm({
  employee,
  door = 'hr',
  initialTab,
  flaggedSampleId,
  teams,
  positions: _positions,
  onClose,
  onSaved,
}: {
  employee: EmployeeRow | null;
  /** For a new person: which screen is asking (see `PersonDoor`). */
  door?: PersonDoor;
  /** The tab a deep link asks for (`?tab=face`). */
  initialTab?: EmployeeTab;
  /** A face sample Face health flagged (`?sample=`), marked on the Face samples tab. */
  flaggedSampleId?: string | null;
  teams: TeamOption[];
  positions: PositionOption[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const { can } = useAuth();
  const toast = useToast();
  // Per record, as the API decides it (2026-10-18: own rates for an Own holder).
  const seeRates = employee?.canSeeRates ?? can('ghr.employee_rates.view_all');
  const setRates = employee?.canEditRates ?? can('ghr.employee_rates.edit_all');
  const seeEvaluations = !!employee && can('ghr.evaluations.view_all');
  const seeFlow = !!employee && can('ghr.people_flow.view_all');
  // The samples the clock matches this person against: HR's to look at and
  // remove (a blurred one, or someone else's); they are only ever ADDED by
  // the person on the Clock page.
  const seeFaces = !!employee && can('ghr.employees.edit_all');
  // Admin › Users: the login is why the form is open, so it comes first.
  const adminDoor = !employee && door === 'admin';
  const [tab, setTab] = useState<EmployeeTab>(adminDoor ? 'login' : initialTab === 'face' && seeFaces ? 'face' : 'person');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  // Naming a login is not the admin right — the people lookup, not /users.
  const { people: users } = usePeople();
  const loginField = useId();
  const seeUsers = can('admin.users.view_all');
  const [detail, setDetail] = useState<EmployeeRow | null>(null);

  /*
    "One creation": the person and their G-CORE login saved together, and the
    invitation sent. Making a login is the administrator's right; without it
    the tab says so and the employee saves on their own.
  */
  const canMakeLogins = can('admin.users.create');
  // In the admin door the login is required: the tick is on and locked.
  const [makeLogin, setMakeLogin] = useState(!employee && canMakeLogins);
  /*
    Admin › Users may also give a login to someone HR already registered —
    the branch that used to be the "Employee record" picker on the old New
    user form. Each branch needs its own right; a viewer with only one of
    them gets no choice, just that branch.
  */
  const mayNewPerson = can('ghr.employees.create');
  const mayLinkExisting = adminDoor && canMakeLogins && can('ghr.employees.edit_all');
  const [who, setWho] = useState<'new' | 'existing'>(adminDoor && !mayNewPerson && mayLinkExisting ? 'existing' : 'new');
  const forExisting = adminDoor && who === 'existing';
  /*
    Reading the register is not the right to change it: a viewer (finance)
    gets the record to read and Close, never a Save the PATCH would refuse.
    A new record's Save follows the BRANCH (2026-10-10): the new-person branch
    is `create`'s and the already-on-the-register branch is `edit_all`'s —
    the right `POST /employees/:id/login` itself checks — so an administrator
    holding only the second is not shown the branch with nothing to save it.
  */
  const mayEdit = employee ? (employee.canEdit ?? can('ghr.employees.edit_all')) : forExisting ? mayLinkExisting : mayNewPerson;
  const [existingId, setExistingId] = useState('');
  const [registerQ, setRegisterQ] = useState('');
  /** null while loading, 'failed' when the lookup refused (the viewer cannot read the register). */
  const [register, setRegister] = useState<RegisterOption[] | 'failed' | null>(null);
  const [login, setLogin] = useState<LoginDraft>({
    email: employee?.personalEmail ?? '',
    supervisorId: '',
    roleIds: [],
    method: 'invite',
    password: '',
  });
  /** Until the login email is typed, it follows the personal email. */
  const [loginEmailTouched, setLoginEmailTouched] = useState(false);
  const [roles, setRoles] = useState<RoleOption[] | null>(null);
  const [issued, setIssued] = useState<{ delivery: Delivery; email: string; name: string; created: boolean } | null>(null);
  /**
   * The login the email already belongs to, when the server says so (a 409
   * whose details carry `existingLogin`): a login with no employee record yet
   * is offered to link — one click — instead of a second account.
   */
  const [existingLogin, setExistingLogin] = useState<ExistingLogin | null>(null);

  const [form, setForm] = useState({
    employeeNo: employee?.employeeNo ?? '',
    firstName: employee?.firstName ?? '',
    lastName: employee?.lastName ?? '',
    middleName: employee?.middleName ?? '',
    suffix: employee?.suffix ?? '',
    userId: employee?.user?.id ?? '',
    industryId: employee?.industry?.id ?? '',
    position: employee?.position ?? '',
    positionId: employee?.positionId ?? '',
    extraPositionIds: (employee?.extraPositions ?? []).map((x) => x.position.id),
    employmentType: employee?.employmentType ?? 'REGULAR',
    dateHired: employee?.dateHired?.slice(0, 10) ?? '',
    dateRegularized: employee?.dateRegularized?.slice(0, 10) ?? '',
    periodEndDate: employee?.periodEndDate?.slice(0, 10) ?? '',
    dateSeparated: employee?.dateSeparated?.slice(0, 10) ?? '',
    mobile: employee?.mobile ?? '',
    personalEmail: employee?.personalEmail ?? '',
    address: employee?.address ?? '',
    birthDate: employee?.birthDate?.slice(0, 10) ?? '',
    emergencyContactName: employee?.emergencyContactName ?? '',
    emergencyContactPhone: employee?.emergencyContactPhone ?? '',
    dailyRate: '',
    burdenMultiplier: '',
    sssNo: '',
    philhealthNo: '',
    pagibigNo: '',
    tin: '',
    isActive: employee?.isActive ?? true,
    notes: employee?.notes ?? '',
  });

  // The roles a new login can start with; the self-service Employee role is ticked.
  useEffect(() => {
    if (!canMakeLogins) return;
    api
      .get<RoleOption[]>('/roles')
      .then((rows) => {
        setRoles(rows);
        const starter = rows.find((r) => r.key === 'employee');
        if (starter) setLogin((l) => (l.roleIds.length ? l : { ...l, roleIds: [starter.id] }));
      })
      .catch(() => setRoles(null));
  }, [canMakeLogins]);

  // The register, for a login that goes to someone already on it: active
  // people with no login, fifty at a time, so a search box narrows it.
  useEffect(() => {
    if (!mayLinkExisting) return;
    let live = true;
    const timer = setTimeout(() => {
      api
        .get<RegisterOption[]>(`/employees/lookup?active=true${registerQ.trim() ? `&q=${encodeURIComponent(registerQ.trim())}` : ''}`)
        .then((rows) => live && setRegister(rows.filter((e) => !e.hasUser)))
        .catch(() => live && setRegister('failed'));
    }, 250);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [mayLinkExisting, registerQ]);

  // The lookup lists ACTIVE logins and ACTIVE positions. The record's own may
  // be neither (a leaver), and a select that cannot show its value lies.
  const linked = employee?.user ?? null;
  // A login is told apart by the email it signs in with, so that is what the
  // choice shows beside the name.
  const loginOptions: PersonRow[] = users.map((u) => ({ ...u, position: u.email ?? u.position }));

  // The list never carries pay data — fetch the full record when editing so the
  // rate fields are populated for someone allowed to see them.
  useEffect(() => {
    if (!employee || !seeRates) return;
    api
      .get<EmployeeRow>(`/employees/${employee.id}`)
      .then((full) => {
        setDetail(full);
        setForm((f) => ({
          ...f,
          dailyRate: full.dailyRate?.toString() ?? '',
          burdenMultiplier: full.burdenMultiplier?.toString() ?? '',
          sssNo: full.sssNo ?? '',
          philhealthNo: full.philhealthNo ?? '',
          pagibigNo: full.pagibigNo ?? '',
          tin: full.tin ?? '',
        }));
      })
      .catch(() => {});
  }, [employee, seeRates]);

  /** What a new login is sent as — the tab's choices, checked here first. */
  function loginPayload(): Record<string, unknown> {
    if (!login.email.trim()) throw new Error('Enter the email they will sign in with — see the G-CORE login tab');
    if (login.method === 'password' && login.password.length < 8) {
      throw new Error('Set a password of at least 8 characters, or invite them to choose their own');
    }
    return {
      email: login.email.trim(),
      supervisorId: login.supervisorId || null,
      ...(roles ? { roleIds: login.roleIds } : {}),
      ...(login.method === 'password' ? { password: login.password } : {}),
    };
  }

  /** A login for someone already on the register, from their record. */
  async function createLoginNow() {
    if (!employee) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api.post<{ user: { email: string }; invite: Delivery | null }>(
        `/employees/${employee.id}/login`,
        loginPayload(),
      );
      if (r.invite) setIssued({ delivery: r.invite, email: r.user.email, name: `${employee.firstName} ${employee.lastName}`, created: false });
      else {
        toast('ok', `Login created for ${employee.firstName} ${employee.lastName}`);
        onSaved();
      }
    } catch (err) {
      // The server's words alone: the field line under them would say the same again.
      setError(existingLoginIn(err) ? new Error((err as Error).message) : err);
    } finally {
      setBusy(false);
    }
  }

  async function resendInvite() {
    if (!employee?.user) return;
    setBusy(true);
    setError(null);
    try {
      const delivery = await api.post<Delivery>(`/users/${employee.user.id}/invite`);
      setIssued({ delivery, email: employee.user.email, name: `${employee.firstName} ${employee.lastName}`, created: false });
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  /** Saves; `linkTo` links an existing login instead of making one (the 409's offer). */
  async function save(linkTo?: ExistingLogin) {
    setBusy(true);
    setError(null);
    setExistingLogin(null);
    try {
      // Admin › Users, for someone HR already registered: the login alone,
      // onto their record — the same route the record's own login tab uses.
      if (forExisting) {
        const chosen = register !== 'failed' ? register?.find((e) => e.id === existingId) : undefined;
        if (!chosen) throw new Error('Choose who on the register this login is for');
        const name = `${chosen.firstName} ${chosen.lastName}`;
        const r = await api.post<{ user: { email: string }; invite: Delivery | null }>(`/employees/${chosen.id}/login`, loginPayload());
        if (r.invite) {
          setIssued({ delivery: r.invite, email: r.user.email, name, created: true });
          setBusy(false);
          return;
        }
        toast('ok', `${name} added`);
        onSaved();
        return;
      }

      const payload: Record<string, unknown> = {
        employeeNo: form.employeeNo || undefined,
        firstName: form.firstName,
        lastName: form.lastName,
        middleName: form.middleName || null,
        suffix: form.suffix || null,
        userId: form.userId || null,
        industryId: form.industryId || null,
        employmentType: form.employmentType,
        dateHired: form.dateHired || null,
        dateRegularized: form.dateRegularized || null,
        // Only meaningful on a probationer or trainee; cleared otherwise so a
        // regularised employee does not carry a stale end date around.
        periodEndDate:
          ['PROBATIONARY', 'TRAINEE'].includes(form.employmentType) && form.periodEndDate
            ? form.periodEndDate
            : null,
        dateSeparated: form.dateSeparated || null,
        mobile: form.mobile || null,
        personalEmail: form.personalEmail || null,
        address: form.address || null,
        birthDate: form.birthDate || null,
        emergencyContactName: form.emergencyContactName || null,
        emergencyContactPhone: form.emergencyContactPhone || null,
        isActive: form.isActive,
        notes: form.notes || null,
      };

      // The position goes through the server's one writer of the mirror. Sent
      // only when it changed, so an employee on a since-deactivated position
      // can still be saved for something else.
      // The title is the highest role once there is a login (ROLE_REV1, 2026-10-19);
      // until then it is free text.
      if (!employee?.user && !form.positionId) payload.position = form.position.trim() || null;

      if (setRates) {
        payload.dailyRate = form.dailyRate === '' ? null : Number(form.dailyRate);
        payload.burdenMultiplier =
          form.burdenMultiplier === '' ? null : Number(form.burdenMultiplier);
        payload.sssNo = form.sssNo || null;
        payload.philhealthNo = form.philhealthNo || null;
        payload.pagibigNo = form.pagibigNo || null;
        payload.tin = form.tin || null;
      }

      if (linkTo) {
        payload.userId = linkTo.id;
      } else if (!employee && (makeLogin || adminDoor)) {
        payload.login = loginPayload();
        delete payload.userId;
      }

      if (employee) {
        await api.patch(`/employees/${employee.id}`, payload);
      } else {
        const created = await api.post<{ login: { user: { email: string }; invite: Delivery | null } | null }>(
          '/employees',
          payload,
        );
        // The invitation stays on screen so its link can be passed on.
        if (created.login?.invite) {
          toast('ok', `${form.firstName} ${form.lastName} added, with their login`);
          setIssued({ delivery: created.login.invite, email: created.login.user.email, name: `${form.firstName} ${form.lastName}`, created: true });
          setBusy(false);
          return;
        }
      }

      toast(
        'ok',
        linkTo
          ? `${form.firstName} ${form.lastName} ${employee ? 'saved' : 'added'}, linked to the login ${linkTo.email}`
          : employee
            ? `${form.firstName} ${form.lastName} saved`
            : `${form.firstName} ${form.lastName} added`,
      );
      onSaved();
    } catch (err) {
      const found = existingLoginIn(err);
      setExistingLogin(found);
      // A login that can be linked is said once, in the offer; one on another
      // employee's record is the server's words alone, without the field line.
      setError(found ? (found.linkable && !forExisting && mayEdit ? null : new Error((err as Error).message)) : err);
      setBusy(false);
    }
  }

  /** Asked in the modal's foot first; a refusal is shown there, so it throws. */
  async function remove() {
    if (!employee) return;
    await api.del(`/employees/${employee.id}`);
    toast('ok', 'Employee deleted');
    onSaved();
  }

  const burdened =
    form.dailyRate && form.burdenMultiplier
      ? Number(form.dailyRate) * Number(form.burdenMultiplier)
      : null;

  // An invitation just issued: its link, and a way out. Its own key and no
  // guard: it sits where the form's Modal sat, and React would otherwise keep
  // that Modal — and its "something was typed" flag — asking "Close without
  // saving?" about a person already saved.
  if (issued) {
    return (
      <Modal
        key="issued"
        guard={false}
        title={issued.created ? `${issued.name} added` : `Invitation for ${issued.name}`}
        onClose={onSaved}
        footer={<ModalFoot onCancel={onSaved} cancelLabel="Close" />}
      >
        <LinkDelivery delivery={issued.delivery} email={issued.email} kind="invite" />
        <p className="muted">
          When they open it they choose their password, add their photo and check their details. Until then their
          login shows as invited.
        </p>
      </Modal>
    );
  }

  return (
    <Modal
      wide
      title={
        employee
          ? mayEdit
            ? `Modify employee ${employee.firstName} ${employee.lastName}`
            : `${employee.firstName} ${employee.lastName}`
          : adminDoor
            ? 'New user'
            : 'New employee'
      }
      onClose={onClose}
      footer={
        <ModalFoot
          onCancel={onClose}
          cancelLabel={mayEdit ? 'Cancel' : 'Close'}
          busy={busy}
          danger={
            employee && can('ghr.employees.delete')
              ? {
                  label: 'Delete',
                  question: `Delete ${employee.firstName} ${employee.lastName}? It cannot be undone. Someone with attendance, a clearance, an evaluation or training on file cannot be deleted — make them inactive instead.`,
                  onConfirm: remove,
                }
              : undefined
          }
        >
          {mayEdit && (
            <button
              className="btn btn-primary"
              onClick={() => void save()}
              disabled={busy || (forExisting ? !existingId : !form.firstName || !form.lastName)}
            >
              {busy ? 'Saving…' : 'Save'}
            </button>
          )}
        </ModalFoot>
      }
    >
      <ErrorBox error={error} />
      {existingLogin?.linkable && !forExisting && mayEdit && (
        <div className="alert info row existing-login-offer">
          <span>
            <span className="mono">{existingLogin.email}</span> is already the G-CORE login of{' '}
            <strong>{existingLogin.name}</strong>, who has no employee record yet. Link{' '}
            <strong>{form.firstName || 'this person'} {form.lastName}</strong> to it — its roles and reporting line stay as
            they are{existingLogin.isActive === false ? ', and it stays switched off' : ''} — or use another email.
          </span>
          <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void save(existingLogin)}>
            Link the existing login
          </button>
        </div>
      )}

      <div className="row" style={{ marginBottom: 'var(--s-4)' }}>
        <div className="scope-switch">
          {adminDoor && (
            <button className={tab === 'login' ? 'active' : ''} onClick={() => setTab('login')}>
              G-CORE login
            </button>
          )}
          {!forExisting && (
            <>
              <button className={tab === 'person' ? 'active' : ''} onClick={() => setTab('person')}>
                Person
              </button>
              <button className={tab === 'employment' ? 'active' : ''} onClick={() => setTab('employment')}>
                Employment
              </button>
            </>
          )}
          {!adminDoor && (
            <button className={tab === 'login' ? 'active' : ''} onClick={() => setTab('login')}>
              G-CORE login
            </button>
          )}
          {seeRates && !forExisting && (
            <button className={tab === 'pay' ? 'active' : ''} onClick={() => setTab('pay')}>
              Pay &amp; statutory
            </button>
          )}
          {seeEvaluations && (
            <button className={tab === 'evaluations' ? 'active' : ''} onClick={() => setTab('evaluations')}>
              Evaluations
            </button>
          )}
          {seeFlow && (
            <button className={tab === 'flow' ? 'active' : ''} onClick={() => setTab('flow')}>
              People Flow
            </button>
          )}
          {seeFaces && (
            <button className={tab === 'face' ? 'active' : ''} onClick={() => setTab('face')}>
              Face samples
            </button>
          )}
        </div>
      </div>

      {tab === 'person' && (
        <>
          <div className="grid grid-2">
            <Field label="Last name">
              <input value={form.lastName} onChange={(e) => setForm({ ...form, lastName: e.target.value })} />
            </Field>
            <Field label="First name">
              <input value={form.firstName} onChange={(e) => setForm({ ...form, firstName: e.target.value })} />
            </Field>
            <Field label="Middle name">
              <input value={form.middleName} onChange={(e) => setForm({ ...form, middleName: e.target.value })} />
            </Field>
            <Field label="Suffix" hint="Jr., III">
              <input value={form.suffix} onChange={(e) => setForm({ ...form, suffix: e.target.value })} />
            </Field>
            <Field label="Mobile">
              <input value={form.mobile} onChange={(e) => setForm({ ...form, mobile: e.target.value })} />
            </Field>
            <Field label="Personal email">
              <input
                type="email"
                value={form.personalEmail}
                onChange={(e) => {
                  setForm({ ...form, personalEmail: e.target.value });
                  if (!loginEmailTouched && !employee?.user) setLogin((l) => ({ ...l, email: e.target.value }));
                }}
              />
            </Field>
            <Field label="Birth date">
              <input
                type="date"
                value={form.birthDate}
                onChange={(e) => setForm({ ...form, birthDate: e.target.value })}
              />
            </Field>
            <Field label="Address">
              <input value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })} />
            </Field>
            <Field label="Emergency contact">
              <input
                value={form.emergencyContactName}
                onChange={(e) => setForm({ ...form, emergencyContactName: e.target.value })}
              />
            </Field>
            <Field label="Emergency phone">
              <input
                value={form.emergencyContactPhone}
                onChange={(e) => setForm({ ...form, emergencyContactPhone: e.target.value })}
              />
            </Field>
          </div>
        </>
      )}

      {tab === 'employment' && (
        <>
          <div className="grid grid-2">
            <Field label="Employee number" hint="GTC-0001-14 — the sequence, then the year hired. Leave blank for the next number (the year hired from the date below).">
              <input
                className="mono"
                value={form.employeeNo}
                placeholder="GTC-0001-14"
                onChange={(e) => setForm({ ...form, employeeNo: e.target.value })}
              />
            </Field>
            <div>
              {employee?.user ? (
                <Field label="Title" hint="Their highest role on Admin › Users — what documents print">
                  <input readOnly value={employee.position ?? ''} placeholder="— no role yet —" />
                </Field>
              ) : (
                <Field label="Title" hint="Free text until they have a login and roles — then the highest role is their title">
                  <input value={form.position} onChange={(e) => setForm({ ...form, position: e.target.value })} />
                </Field>
              )}
              {employee && can('ghr.passports.view_all') && (
                <p className="muted">
                  <Link to={`/g-hr/academy/passports/${employee.id}`}>Training passport →</Link>
                </p>
              )}
            </div>
            <Field label="Team" hint="The sales team they are on — KAT, HIT, UIT, GIB or SIT — shown to them on their invitation and My Account">
              <select value={form.industryId} onChange={(e) => setForm({ ...form, industryId: e.target.value })}>
                <option value="">— no team yet —</option>
                {teams
                  .filter((t) => t.isActive || t.id === form.industryId)
                  .map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                      {t.isActive ? '' : ' (switched off)'}
                    </option>
                  ))}
              </select>
            </Field>
            <Field label="Employment type">
              <select
                value={form.employmentType}
                onChange={(e) => setForm({ ...form, employmentType: e.target.value })}
              >
                {EMPLOYMENT_TYPES.map((t) => (
                  <option key={t.value} value={t.value}>
                    {t.label}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Date hired">
              <input
                type="date"
                value={form.dateHired}
                onChange={(e) => setForm({ ...form, dateHired: e.target.value })}
              />
            </Field>
            <Field label="Date regularized">
              <input
                type="date"
                value={form.dateRegularized}
                onChange={(e) => setForm({ ...form, dateRegularized: e.target.value })}
              />
            </Field>
            {['PROBATIONARY', 'TRAINEE'].includes(form.employmentType) && (
              <Field
                label="Probation / training ends"
                hint="Evaluations are scheduled against this date. Leave blank to use the HR default."
              >
                <input
                  type="date"
                  value={form.periodEndDate}
                  onChange={(e) => setForm({ ...form, periodEndDate: e.target.value })}
                />
              </Field>
            )}
            <Field label="Date separated" hint="Leave blank while employed">
              <input
                type="date"
                value={form.dateSeparated}
                onChange={(e) => setForm({ ...form, dateSeparated: e.target.value })}
              />
            </Field>
          </div>

          <Field label="Notes">
            <textarea value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
          </Field>

          <Checkbox
            checked={form.isActive}
            onChange={(v) => setForm({ ...form, isActive: v })}
            label="Active — inactive employees drop out of attendance and assignment"
          />
        </>
      )}

      {tab === 'login' && (
        <div className="login-tab">
          {adminDoor && (
            <>
              {mayNewPerson && mayLinkExisting && (
                <fieldset className="signin-choice">
                  <legend>Who the login is for</legend>
                  <label className="checkbox">
                    <input type="radio" name="person-who" checked={who === 'new'} onChange={() => setWho('new')} />
                    <span>A new person — their employee record is made with the login</span>
                  </label>
                  <label className="checkbox">
                    <input
                      type="radio"
                      name="person-who"
                      checked={who === 'existing'}
                      onChange={() => {
                        setWho('existing');
                        setTab('login');
                      }}
                    />
                    <span>An employee already on the register, who has no login yet</span>
                  </label>
                </fieldset>
              )}
              {forExisting ? (
                <div className="grid grid-2">
                  <Field label="Find on the register" hint="Name or employee number — active people with no login yet">
                    <input value={registerQ} onChange={(e) => setRegisterQ(e.target.value)} placeholder="Search…" />
                  </Field>
                  <Field
                    label="Employee"
                    required
                    hint={
                      register === 'failed'
                        ? 'The register could not be listed — try again'
                        : register && register.length === 0
                          ? registerQ.trim()
                            ? 'No active employee without a login matches'
                            : 'Everyone active on the register already has a login'
                          : 'Their record gives the login its name, position and mobile'
                    }
                  >
                    <select value={existingId} onChange={(e) => setExistingId(e.target.value)}>
                      <option value="">— choose —</option>
                      {register !== 'failed' &&
                        register?.map((e) => (
                          <option key={e.id} value={e.id}>
                            {e.lastName}, {e.firstName} · {e.employeeNo}
                            {e.position ? ` · ${e.position}` : ''}
                          </option>
                        ))}
                    </select>
                  </Field>
                </div>
              ) : (
                <p className="muted">
                  One save makes the employee record and the login. Name them on the Person tab; the Employment tab
                  takes their number, position and team.
                </p>
              )}
            </>
          )}
          {linked ? (
            <div className="login-status">
              <p>
                Signs in as{' '}
                {seeUsers ? (
                  <Link to={`/admin/users/${linked.id}`} className="mono">
                    {linked.email}
                  </Link>
                ) : (
                  <span className="mono">{linked.email}</span>
                )}
                {linked.supervisor ? ` · reports to ${linked.supervisor.name}` : ''}
                {!linked.isActive && ' · switched off'}
              </p>
              {linked.invitePending && (
                <div className="row login-status-row">
                  <span className="muted">Invited — they have not chosen a password yet.</span>
                  {canMakeLogins && linked.isActive && (
                    <button type="button" className="btn btn-sm" disabled={busy} onClick={() => void resendInvite()}>
                      Send a new invitation
                    </button>
                  )}
                </div>
              )}
            </div>
          ) : canMakeLogins ? (
            <>
              {!employee && !adminDoor && (
                <Checkbox
                  checked={makeLogin}
                  onChange={setMakeLogin}
                  label="Create their G-CORE login when I save, and send them an invitation"
                />
              )}
              {(employee || makeLogin || adminDoor) && (
                <LoginFields
                  login={login}
                  roles={roles}
                  people={users}
                  onChange={(next) => setLogin(next)}
                  onEmailTyped={() => setLoginEmailTouched(true)}
                />
              )}
              {employee && (
                <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void createLoginNow()}>
                  {login.method === 'invite' ? 'Create login and send invitation' : 'Create login'}
                </button>
              )}
            </>
          ) : (
            <div className="alert info">
              Making a G-CORE login needs an administrator (admin.users.create). Save the employee, and an
              administrator can invite them from this record — or from Admin › Users.
            </div>
          )}

          {/* An existing login can still be linked or unlinked by hand. */}
          {(!makeLogin || !!employee) && !adminDoor && (
            <Field
              label={linked ? 'Login account' : 'Or link a login that already exists'}
              htmlFor={loginField}
              hint={
                can('admin.users.edit_all')
                  ? "Who they sign in as — the login takes this record's name, number, mobile and position. Reporting line is set on the user account, since that is what approvals route by."
                  : "Who they sign in as. Linking or unlinking a login is an administrator's (admin.users.edit_all)."
              }
            >
              <PersonSelect
                id={loginField}
                disabled={!can('admin.users.edit_all')}
                value={form.userId}
                onChange={(id) => setForm({ ...form, userId: id })}
                people={loginOptions}
                placeholder="— no login —"
                current={linked ? { id: linked.id, name: `${linked.email} (inactive)` } : null}
              />
            </Field>
          )}
        </div>
      )}

      {tab === 'face' && seeFaces && employee && (
        <FaceSamplesPanel employeeId={employee.id} self={false} editable flaggedSampleId={flaggedSampleId} />
      )}

      {tab === 'flow' && seeFlow && employee && <EmployeeFlowTab employeeId={employee.id} />}

      {tab === 'evaluations' && seeEvaluations && employee && (
        <EmployeeEvaluationsTab
          employeeId={employee.id}
          employmentType={employee.employmentType}
          dateRegularized={employee.dateRegularized}
        />
      )}

      {tab === 'pay' && seeRates && (
        <>
          {!setRates && (
            <div className="alert info">
              You can see pay data but not change it. That needs{' '}
              <span className="mono">ghr.employee_rates.edit_all</span>.
            </div>
          )}

          <div className="grid grid-2">
            <Field label="Daily rate">
              <NumberInput
                kind="money"
                step="0.01"
                value={form.dailyRate}
                disabled={!setRates}
                onChange={(e) => setForm({ ...form, dailyRate: e.target.value })}
              />
            </Field>
            <Field
              label="Burden multiplier"
              hint="Covers statutory contributions, leave accrual and overhead. 1.0 means no burden."
            >
              <NumberInput
                kind="decimal"
                step="0.001"
                min="1"
                value={form.burdenMultiplier}
                disabled={!setRates}
                placeholder="1.35"
                onChange={(e) => setForm({ ...form, burdenMultiplier: e.target.value })}
              />
            </Field>
          </div>

          <div className="alert info">
            {burdened ? (
              <>
                Projects will be charged <strong>{formatMoney(burdened)}</strong> per day for this
                person, not the {formatMoney(Number(form.dailyRate))} wage.
              </>
            ) : (
              'Set both a daily rate and a burden multiplier to see what a project will actually be charged.'
            )}
          </div>

          <div className="grid grid-2">
            <Field label="SSS number">
              <input
                className="mono"
                value={form.sssNo}
                disabled={!setRates}
                onChange={(e) => setForm({ ...form, sssNo: e.target.value })}
              />
            </Field>
            <Field label="PhilHealth number">
              <input
                className="mono"
                value={form.philhealthNo}
                disabled={!setRates}
                onChange={(e) => setForm({ ...form, philhealthNo: e.target.value })}
              />
            </Field>
            <Field label="Pag-IBIG number">
              <input
                className="mono"
                value={form.pagibigNo}
                disabled={!setRates}
                onChange={(e) => setForm({ ...form, pagibigNo: e.target.value })}
              />
            </Field>
            <Field label="TIN">
              <input
                className="mono"
                value={form.tin}
                disabled={!setRates}
                onChange={(e) => setForm({ ...form, tin: e.target.value })}
              />
            </Field>
          </div>

          {employee && !detail && (
            <p className="faint">
              Loading pay data…
            </p>
          )}
        </>
      )}
    </Modal>
  );
}

interface RoleOption {
  id: string;
  key: string;
  name: string;
}

interface LoginDraft {
  email: string;
  supervisorId: string;
  roleIds: string[];
  method: 'invite' | 'password';
  password: string;
}

/**
 * The login's own choices: the email they sign in with, who approves for them
 * (approvals route by the login, so the reporting line is set here), what they
 * can open, and how they get in — invited to choose their own password, or
 * given one now.
 */
function LoginFields({
  login,
  roles,
  people,
  onChange,
  onEmailTyped,
}: {
  login: LoginDraft;
  roles: RoleOption[] | null;
  people: PersonRow[];
  onChange: (next: LoginDraft) => void;
  onEmailTyped: () => void;
}) {
  const supervisorField = useId();
  return (
    <div className="login-fields">
      <div className="grid grid-2">
        <Field label="Sign-in email" required hint="Their work email if they have one — the invitation goes here">
          <input
            type="email"
            autoComplete="off"
            value={login.email}
            onChange={(e) => {
              onEmailTyped();
              onChange({ ...login, email: e.target.value });
            }}
          />
        </Field>
        <Field label="Reports to" htmlFor={supervisorField} hint="Their leave and overtime go to this person first">
          <PersonSelect
            id={supervisorField}
            value={login.supervisorId}
            onChange={(id) => onChange({ ...login, supervisorId: id })}
            people={people}
            placeholder="— none (HR decides) —"
          />
        </Field>
      </div>

      {roles ? (
        <Field label="What they can open" hint="Roles — Employee covers clocking in, leave and overtime. Fine-tune later in Admin › Users.">
          <div className="row login-roles">
            {roles.map((r) => (
              <label key={r.id} className="checkbox">
                <input
                  type="checkbox"
                  checked={login.roleIds.includes(r.id)}
                  onChange={(e) =>
                    onChange({
                      ...login,
                      roleIds: e.target.checked ? [...login.roleIds, r.id] : login.roleIds.filter((x) => x !== r.id),
                    })
                  }
                />
                <span>{r.name}</span>
              </label>
            ))}
          </div>
        </Field>
      ) : (
        <p className="muted">They start with the Employee role — clocking in, leave and overtime. Add more in Admin › Users.</p>
      )}

      <fieldset className="signin-choice">
        <legend>How they get in</legend>
        <label className="checkbox">
          <input type="radio" name="employee-signin" checked={login.method === 'invite'} onChange={() => onChange({ ...login, method: 'invite' })} />
          <span>Invite them — they choose their own password, and add their photo and details</span>
        </label>
        <label className="checkbox">
          <input type="radio" name="employee-signin" checked={login.method === 'password'} onChange={() => onChange({ ...login, method: 'password' })} />
          <span>Set a password for them now</span>
        </label>
        {login.method === 'password' && (
          <Field label="Password" htmlFor="employee-login-password" hint="At least 8 characters — tell them, and ask them to change it">
            <PasswordInput
              id="employee-login-password"
              value={login.password}
              autoComplete="new-password"
              onChange={(e) => onChange({ ...login, password: e.target.value })}
            />
          </Field>
        )}
      </fieldset>
    </div>
  );
}
