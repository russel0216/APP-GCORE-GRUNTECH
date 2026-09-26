import { useEffect, useState } from 'react';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { DataList, type Column } from '../../components/DataList';
import { ImportModal, loadImportSpec } from '../../components/ImportModal';
import { Checkbox, ErrorBox, Field, Modal, formatDate, formatMoney, useToast } from '../../components/ui';

const EMPLOYMENT_TYPES = [
  { value: 'REGULAR', label: 'Regular' },
  { value: 'PROBATIONARY', label: 'Probationary' },
  { value: 'TRAINEE', label: 'Trainee' },
  { value: 'PROJECT_BASED', label: 'Project-based' },
  { value: 'CONTRACTUAL', label: 'Contractual' },
  { value: 'PART_TIME', label: 'Part-time' },
];

interface EmployeeRow {
  id: string;
  employeeNo: string;
  firstName: string;
  lastName: string;
  middleName: string | null;
  suffix: string | null;
  position: string | null;
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
  department: { id: string; name: string } | null;
  user: { id: string; email: string; isActive: boolean } | null;
  // Only present when the caller holds ghr.employee_rates.view_all
  dailyRate?: number | null;
  burdenMultiplier?: number | null;
  sssNo?: string | null;
  philhealthNo?: string | null;
  pagibigNo?: string | null;
  tin?: string | null;
}

export function Employees() {
  const { can } = useAuth();
  const [editing, setEditing] = useState<EmployeeRow | 'new' | null>(null);
  const [importing, setImporting] = useState<{ label: string; columns: never[] } | null>(null);
  const [reload, setReload] = useState(0);
  const [departments, setDepartments] = useState<{ id: string; name: string }[]>([]);

  const seeRates = can('ghr.employee_rates.view_all');

  useEffect(() => {
    api.get<{ id: string; name: string }[]>('/departments').then(setDepartments).catch(() => {});
  }, []);

  const columns: Column<EmployeeRow>[] = [
    {
      key: 'employeeNo',
      label: 'Employee No.',
      sortKey: 'employeeNo',
      width: '170px',
      render: (e) => <span className="mono">{e.employeeNo}</span>,
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
          <div className="faint">{e.position ?? '—'}</div>
        </div>
      ),
    },
    { key: 'department', label: 'Department', render: (e) => e.department?.name ?? '—' },
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
          <span className="mono" title={e.user.email}>
            {e.user.email}
          </span>
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
        <span className={`badge ${e.isActive ? 'ok' : ''}`}>{e.isActive ? 'Active' : 'Inactive'}</span>
      ),
    },
  ];

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Employees</h1>
          <p>
            The people record — used by attendance, leave and overtime, and by projects for labour
            cost. Pay data is a separate permission: a project manager sees headcount and
            assignment, never salaries.
          </p>
        </div>
      </div>

      <DataList<EmployeeRow>
        listKey="employees"
        endpoint="/employees"
        columns={columns}
        rowKey={(e) => e.id}
        searchPlaceholder="Search name, employee number, position…"
        reloadToken={reload}
        onRowClick={(e) => setEditing(e)}
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
            key: 'departmentId',
            label: 'Department',
            options: departments.map((d) => ({ value: d.id, label: d.name })),
          },
          { key: 'employmentType', label: 'Type', options: EMPLOYMENT_TYPES },
        ]}
        actions={
          <>
            {can('ghr.employees.create') && (
              <button className="btn btn-primary btn-sm" onClick={() => setEditing('new')}>
                + Add employee
              </button>
            )}
            {can('ghr.employees.create') && (
              <button
                className="btn btn-sm"
                onClick={async () => {
                  const spec = await loadImportSpec('employees');
                  if (spec) setImporting(spec as { label: string; columns: never[] });
                }}
              >
                Import
              </button>
            )}
          </>
        }
      />

      {editing && (
        <EmployeeForm
          employee={editing === 'new' ? null : editing}
          departments={departments}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
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

function EmployeeForm({
  employee,
  departments,
  onClose,
  onSaved,
}: {
  employee: EmployeeRow | null;
  departments: { id: string; name: string }[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const { can } = useAuth();
  const toast = useToast();
  const seeRates = can('ghr.employee_rates.view_all');
  const setRates = can('ghr.employee_rates.edit_all');

  const [tab, setTab] = useState<'person' | 'employment' | 'pay'>('person');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [users, setUsers] = useState<{ id: string; name: string; email: string }[]>([]);
  const [detail, setDetail] = useState<EmployeeRow | null>(null);

  const [form, setForm] = useState({
    employeeNo: employee?.employeeNo ?? '',
    firstName: employee?.firstName ?? '',
    lastName: employee?.lastName ?? '',
    middleName: employee?.middleName ?? '',
    suffix: employee?.suffix ?? '',
    userId: employee?.user?.id ?? '',
    departmentId: employee?.department?.id ?? '',
    position: employee?.position ?? '',
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

  useEffect(() => {
    api
      .get<{ rows: { id: string; name: string; email: string }[] }>('/users?pageSize=200')
      .then((r) => setUsers(r.rows))
      .catch(() => {});
  }, []);

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

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const payload: Record<string, unknown> = {
        employeeNo: form.employeeNo || undefined,
        firstName: form.firstName,
        lastName: form.lastName,
        middleName: form.middleName || null,
        suffix: form.suffix || null,
        userId: form.userId || null,
        departmentId: form.departmentId || null,
        position: form.position || null,
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

      if (setRates) {
        payload.dailyRate = form.dailyRate === '' ? null : Number(form.dailyRate);
        payload.burdenMultiplier =
          form.burdenMultiplier === '' ? null : Number(form.burdenMultiplier);
        payload.sssNo = form.sssNo || null;
        payload.philhealthNo = form.philhealthNo || null;
        payload.pagibigNo = form.pagibigNo || null;
        payload.tin = form.tin || null;
      }

      if (employee) await api.patch(`/employees/${employee.id}`, payload);
      else await api.post('/employees', payload);

      toast('ok', `${form.firstName} ${form.lastName} saved`);
      onSaved();
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  }

  async function remove() {
    if (!employee) return;
    setBusy(true);
    try {
      await api.del(`/employees/${employee.id}`);
      toast('ok', 'Employee deleted');
      onSaved();
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  }

  const burdened =
    form.dailyRate && form.burdenMultiplier
      ? Number(form.dailyRate) * Number(form.burdenMultiplier)
      : null;

  return (
    <Modal
      wide
      title={employee ? `${employee.firstName} ${employee.lastName}` : 'Add employee'}
      onClose={onClose}
      footer={
        <>
          {employee && can('ghr.employees.delete') && (
            <button className="btn btn-danger" onClick={remove} disabled={busy}>
              Delete
            </button>
          )}
          <div style={{ flex: 1 }} />
          <button className="btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button
            className="btn btn-primary"
            onClick={save}
            disabled={busy || !form.firstName || !form.lastName}
          >
            {busy ? 'Saving…' : 'Save'}
          </button>
        </>
      }
    >
      <ErrorBox error={error} />

      <div className="row" style={{ marginBottom: 16 }}>
        <div className="scope-switch">
          <button className={tab === 'person' ? 'active' : ''} onClick={() => setTab('person')}>
            Person
          </button>
          <button className={tab === 'employment' ? 'active' : ''} onClick={() => setTab('employment')}>
            Employment
          </button>
          {seeRates && (
            <button className={tab === 'pay' ? 'active' : ''} onClick={() => setTab('pay')}>
              Pay &amp; statutory
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
                onChange={(e) => setForm({ ...form, personalEmail: e.target.value })}
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
            <Field label="Employee number" hint="Leave blank to auto-generate">
              <input
                className="mono"
                value={form.employeeNo}
                onChange={(e) => setForm({ ...form, employeeNo: e.target.value })}
              />
            </Field>
            <Field label="Position">
              <input value={form.position} onChange={(e) => setForm({ ...form, position: e.target.value })} />
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
            <Field
              label="Login account"
              hint="Who they sign in as. Reporting line is set on the user account, since that is what approvals route by."
            >
              <select value={form.userId} onChange={(e) => setForm({ ...form, userId: e.target.value })}>
                <option value="">— no login —</option>
                {users.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.name} ({u.email})
                  </option>
                ))}
              </select>
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
              <input
                type="number"
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
              <input
                type="number"
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
            <p className="faint" style={{ fontSize: 12 }}>
              Loading pay data…
            </p>
          )}
        </>
      )}
    </Modal>
  );
}
