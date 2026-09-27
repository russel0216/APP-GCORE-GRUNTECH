import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { DataList, type Column } from '../../components/DataList';
import { BarList, Meter, Panel, Stat } from '../../components/charts';
import { Checkbox, ErrorBox, Field, Loading, Modal, StatusBadge, useToast } from '../../components/ui';

/**
 * The plantilla — the authorised staffing pattern.
 *
 * Positions per department, how many of each the company has approved, who
 * fills them and what is vacant. Filled and vacant are counted off ACTIVE
 * employees by the API on every read; this screen never stores or adds a
 * number of its own, so it is right the moment someone is hired or cleared.
 */

export interface PlantillaSummary {
  authorised: number;
  filled: number;
  vacant: number;
  overComplement: number;
  unclassified: number;
  byDepartment: {
    department: { id: string; name: string } | null;
    authorised: number;
    filled: number;
    vacant: number;
    overComplement: number;
  }[];
}

interface Holder {
  id: string;
  employeeNo: string;
  name: string;
  employmentType: string;
}

interface PositionRow {
  id: string;
  code: string;
  title: string;
  description: string | null;
  isActive: boolean;
  sortOrder: number;
  authorisedHeadcount: number;
  department: { id: string; name: string } | null;
  filled: number;
  /** Authorised − filled. Negative is over-complement. */
  vacant: number;
  holderCount: number;
  holders: Holder[];
}

/** One pill vocabulary for the fill state — rule 12, through statusTone's extra map. */
const FILL_TONE = { FILLED: 'ok', VACANT: 'warn', OVER: 'danger' } as const;

function fillState(p: { vacant: number }): { status: keyof typeof FILL_TONE; label: string } {
  if (p.vacant > 0) return { status: 'VACANT', label: `${p.vacant} vacant` };
  if (p.vacant < 0) return { status: 'OVER', label: `${-p.vacant} over` };
  return { status: 'FILLED', label: 'Filled' };
}

export function Plantilla() {
  const { can } = useAuth();
  const [summary, setSummary] = useState<PlantillaSummary | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [departments, setDepartments] = useState<{ id: string; name: string }[]>([]);
  const [editing, setEditing] = useState<PositionRow | 'new' | null>(null);
  const [reload, setReload] = useState(0);

  const loadSummary = useCallback(() => {
    api
      .get<PlantillaSummary>('/positions/summary')
      .then((s) => {
        setSummary(s);
        setError(null);
      })
      .catch(setError);
  }, []);

  useEffect(() => {
    loadSummary();
  }, [loadSummary, reload]);

  useEffect(() => {
    api.get<{ id: string; name: string }[]>('/departments').then(setDepartments).catch(() => {});
  }, []);

  const columns: Column<PositionRow>[] = [
    {
      key: 'title',
      label: 'Position',
      sortKey: 'title',
      render: (p) => (
        <div>
          <strong>{p.title}</strong>
          <div className="faint mono">{p.code}</div>
        </div>
      ),
    },
    {
      key: 'department',
      label: 'Department',
      sortKey: 'department',
      render: (p) => p.department?.name ?? <span className="faint">No department</span>,
    },
    {
      key: 'authorised',
      label: 'Authorised',
      sortKey: 'authorisedHeadcount',
      align: 'right',
      render: (p) => <span className="mono">{p.authorisedHeadcount}</span>,
    },
    {
      key: 'filled',
      label: 'Filled',
      sortKey: 'filled',
      align: 'right',
      render: (p) => <span className="mono">{p.filled}</span>,
    },
    {
      key: 'vacant',
      label: 'Vacant',
      sortKey: 'vacant',
      align: 'right',
      render: (p) => {
        const s = fillState(p);
        return <StatusBadge status={s.status} extra={FILL_TONE} label={s.label} />;
      },
    },
    {
      key: 'fill',
      label: 'Fill',
      render: (p) => (
        <div className="plantilla-meter">
          <Meter
            pct={p.authorisedHeadcount > 0 ? (p.filled / p.authorisedHeadcount) * 100 : p.filled > 0 ? 100 : 0}
            tone={p.vacant < 0 ? 'danger' : p.vacant > 0 ? 'warn' : undefined}
          />
        </div>
      ),
    },
    {
      key: 'holders',
      label: 'Holders',
      render: (p) =>
        p.holders.length === 0 ? (
          <span className="faint">nobody yet</span>
        ) : (
          // A holder link opens the person, not the position row around it.
          <span
            className="plantilla-holders"
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => e.stopPropagation()}
          >
            {p.holders.slice(0, 3).map((h) => (
              <Link key={h.id} to={`/g-hr/employees/${h.id}`}>
                {h.name}
              </Link>
            ))}
            {p.holderCount > 3 && <span className="faint">+{p.holderCount - 3}</span>}
          </span>
        ),
    },
    {
      key: 'isActive',
      label: 'Status',
      optional: true,
      render: (p) => (
        <StatusBadge status={p.isActive ? 'ACTIVE' : 'INACTIVE'} extra={{ INACTIVE: '' }} />
      ),
    },
  ];

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Plantilla</h1>
          <p>
            The authorised staffing pattern — how many of each position the company has approved,
            who fills them, and what is vacant. Filled and vacant are counted off active employees,
            so they are right the moment someone is hired or cleared.
          </p>
        </div>
      </div>

      <ErrorBox error={error} />

      {!summary ? (
        !error && <Loading />
      ) : (
        <>
          <div className="kpi-grid">
            <Stat label="Authorised" value={summary.authorised} icon="layers" sub="approved headcount" />
            <Stat
              label="Filled"
              value={summary.filled}
              sub={`of ${summary.authorised} authorised`}
              accent="ok"
              icon="people"
            />
            <Stat
              label="Vacant"
              value={summary.vacant}
              sub={summary.vacant > 0 ? 'positions to fill' : 'nothing to fill'}
              accent={summary.vacant > 0 ? 'warn' : 'quiet'}
              to={summary.vacant > 0 ? '/g-hr/plantilla?vacant=true' : undefined}
              more={summary.vacant > 0 ? 'Show vacancies' : undefined}
            />
            <Stat
              label="Over-complement"
              value={summary.overComplement}
              sub={summary.overComplement > 0 ? 'more people than authorised' : 'within the plantilla'}
              accent={summary.overComplement > 0 ? 'danger' : 'quiet'}
              to={summary.overComplement > 0 ? '/g-hr/plantilla?over=true' : undefined}
              more={summary.overComplement > 0 ? 'Show them' : undefined}
            />
            <Stat
              label="Unclassified"
              value={summary.unclassified}
              sub={
                summary.unclassified > 0
                  ? 'active employees with no plantilla position'
                  : 'everyone sits on a position'
              }
              accent={summary.unclassified > 0 ? 'warn' : 'quiet'}
              to={can('ghr.employees.view_all') ? '/g-hr/employees?positionId=none&isActive=true' : undefined}
              more={can('ghr.employees.view_all') ? 'Open employees' : undefined}
            />
          </div>

          <Panel
            title="By department"
            blurb="Filled against authorised. Positions with no department are grouped last."
          >
            <BarList
              slices={summary.byDepartment.map((d) => ({
                label: d.department?.name ?? 'No department',
                value: d.filled,
                display: `${d.filled}/${d.authorised}`,
                tone: d.overComplement > 0 ? 'danger' : d.vacant > 0 ? 'warn' : 'neon',
                to: d.department ? `/g-hr/plantilla?departmentId=${d.department.id}` : undefined,
              }))}
              caption="Active employees on a position, per department"
            />
          </Panel>
        </>
      )}

      <DataList<PositionRow>
        listKey="plantilla"
        endpoint="/positions"
        columns={columns}
        rowKey={(p) => p.id}
        searchPlaceholder="Search title or code…"
        reloadToken={reload}
        onRowClick={(p) => setEditing(p)}
        emptyTitle="No positions yet"
        emptyHint="Add each job title the company employs, and how many of it are authorised."
        filters={[
          {
            key: 'departmentId',
            label: 'Department',
            options: departments.map((d) => ({ value: d.id, label: d.name })),
          },
          { key: 'vacant', label: 'Vacancies', options: [{ value: 'true', label: 'With vacancies' }] },
          { key: 'over', label: 'Over-complement', options: [{ value: 'true', label: 'Over-complement' }] },
          {
            key: 'isActive',
            label: 'Status',
            options: [
              { value: 'true', label: 'Active' },
              { value: 'false', label: 'Inactive' },
            ],
          },
        ]}
        actions={
          can('ghr.plantilla.create') && (
            <button className="btn btn-primary btn-sm" onClick={() => setEditing('new')}>
              + Add position
            </button>
          )
        }
      />

      {editing && (
        <PositionModal
          position={editing === 'new' ? null : editing}
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

function PositionModal({
  position,
  departments,
  onClose,
  onSaved,
}: {
  position: PositionRow | null;
  departments: { id: string; name: string }[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const { can } = useAuth();
  const toast = useToast();
  const mayEdit = position ? can('ghr.plantilla.edit_all') : can('ghr.plantilla.create');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [holders, setHolders] = useState<Holder[] | null>(position ? null : []);
  const [form, setForm] = useState({
    title: position?.title ?? '',
    code: position?.code ?? '',
    departmentId: position?.department?.id ?? '',
    authorisedHeadcount: String(position?.authorisedHeadcount ?? 1),
    description: position?.description ?? '',
    isActive: position?.isActive ?? true,
  });

  // The list shows five holders at most; the modal lists them all.
  useEffect(() => {
    if (!position) return;
    api
      .get<{ holders: Holder[] }>(`/positions/${position.id}`)
      .then((p) => setHolders(p.holders))
      .catch(() => setHolders(position.holders));
  }, [position]);

  const headcount = Number(form.authorisedHeadcount);
  const valid = form.title.trim().length >= 2 && Number.isInteger(headcount) && headcount >= 0;

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const payload = {
        title: form.title.trim(),
        code: form.code.trim() || null,
        departmentId: form.departmentId || null,
        authorisedHeadcount: headcount,
        description: form.description.trim() || null,
        isActive: form.isActive,
      };
      if (position) await api.patch(`/positions/${position.id}`, payload);
      else await api.post('/positions', payload);
      toast('ok', `${payload.title} saved`);
      onSaved();
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  }

  async function remove() {
    if (!position) return;
    setBusy(true);
    setError(null);
    try {
      await api.del(`/positions/${position.id}`);
      toast('ok', `${position.title} deleted`);
      onSaved();
    } catch (err) {
      // A position anyone has held is deactivated, not deleted — the 409 says so.
      setError(err);
      setBusy(false);
    }
  }

  const filled = position?.filled ?? 0;
  const gap = Number.isInteger(headcount) ? headcount - filled : 0;

  return (
    <Modal
      title={position ? `${position.title} · ${position.code}` : 'Add position'}
      onClose={onClose}
      footer={
        <>
          {position && can('ghr.plantilla.delete') && (
            <button className="btn btn-danger" onClick={remove} disabled={busy}>
              Delete
            </button>
          )}
          <div className="plantilla-spacer" />
          <button className="btn" onClick={onClose} disabled={busy}>
            {mayEdit ? 'Cancel' : 'Close'}
          </button>
          {mayEdit && (
            <button className="btn btn-primary" onClick={save} disabled={busy || !valid}>
              {busy ? 'Saving…' : 'Save'}
            </button>
          )}
        </>
      }
    >
      <ErrorBox error={error} />

      <div className="grid grid-2">
        <Field label="Title" required>
          <input
            value={form.title}
            disabled={!mayEdit}
            onChange={(e) => setForm({ ...form, title: e.target.value })}
          />
        </Field>
        <Field label="Code" hint="Leave blank to auto-generate">
          <input
            className="mono"
            value={form.code}
            disabled={!mayEdit}
            onChange={(e) => setForm({ ...form, code: e.target.value })}
          />
        </Field>
        <Field label="Department">
          <select
            value={form.departmentId}
            disabled={!mayEdit}
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
          label="Authorised headcount"
          hint={
            position
              ? gap > 0
                ? `${filled} filled — ${gap} vacant at this figure`
                : gap < 0
                  ? `${filled} filled — ${-gap} over at this figure`
                  : `${filled} filled — exactly full`
              : 'How many of this position the company has approved'
          }
        >
          <input
            type="number"
            min={0}
            step={1}
            value={form.authorisedHeadcount}
            disabled={!mayEdit}
            onChange={(e) => setForm({ ...form, authorisedHeadcount: e.target.value })}
          />
        </Field>
      </div>

      <Field label="Description">
        <textarea
          value={form.description}
          disabled={!mayEdit}
          onChange={(e) => setForm({ ...form, description: e.target.value })}
        />
      </Field>

      {mayEdit && (
        <Checkbox
          checked={form.isActive}
          onChange={(v) => setForm({ ...form, isActive: v })}
          label="Active — an inactive position cannot be given to anyone new"
        />
      )}

      {position && (
        <div className="plantilla-holder-list">
          <div className="section-label">Currently filled by</div>
          {holders === null ? (
            <Loading />
          ) : holders.length === 0 ? (
            <p className="faint">Nobody holds this position.</p>
          ) : (
            <ul>
              {holders.map((h) => (
                <li key={h.id}>
                  <Link to={`/g-hr/employees/${h.id}`}>{h.name}</Link>{' '}
                  <span className="faint mono">{h.employeeNo}</span>
                </li>
              ))}
            </ul>
          )}
          {position.title !== form.title.trim() && form.title.trim().length >= 2 && holders && holders.length > 0 && (
            <div className="alert info">
              Renaming changes the title on every holder&rsquo;s record.
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}
