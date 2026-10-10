import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api } from '../../../lib/api';
import { useAuth } from '../../../lib/auth';
import { DataList, type Column } from '../../../components/DataList';
import { ImportModal, loadImportSpec } from '../../../components/ImportModal';
import { Checkbox, ErrorBox, Field, Loading, Modal, ModalFoot, StatusBadge, useToast } from '../../../components/ui';
import { NumberInput } from '../../../components/NumberInput';

/**
 * Courses — the Academy's master (item 13).
 *
 * A course says what it is, how long it lasts, whether it is assessed and
 * how long a completion stays valid. Its Requirements say who must hold it:
 * a department, a plantilla position, both (the intersection), or — with
 * both left as "any" — everyone. Requirements name a position by id, which
 * is why a course can only be required of a position the plantilla has.
 */

interface CourseRow {
  id: string;
  code: string;
  title: string;
  category: string | null;
  hours: number;
  validityMonths: number | null;
  requiresAssessment: boolean;
  isActive: boolean;
  requirementCount: number;
  requiredOf: string[];
  upcomingSessions: number;
  completions: number;
}

interface Requirement {
  id?: string;
  departmentId: string | null;
  positionId: string | null;
  label?: string;
}

interface CourseDetail {
  id: string;
  code: string;
  title: string;
  category: string | null;
  description: string | null;
  hours: number;
  validityMonths: number | null;
  requiresAssessment: boolean;
  isActive: boolean;
  requirements: Requirement[];
  _count: { sessions: number; records: number };
}

interface PositionOption {
  id: string;
  code: string;
  title: string;
  departmentId: string | null;
  departmentName: string | null;
}

const ACTIVE_TONES = { ACTIVE: 'ok', INACTIVE: '' } as const;

export function Courses() {
  const { can } = useAuth();
  const [params, setParams] = useSearchParams();
  const [open, setOpen] = useState<string | 'new' | null>(params.get('course'));
  const [importing, setImporting] = useState<{ label: string; columns: { header: string; required?: boolean; example?: string; hint?: string }[] } | null>(null);
  const [categories, setCategories] = useState<string[]>([]);
  const [reload, setReload] = useState(0);
  const toast = useToast();

  useEffect(() => {
    api
      .get<{ categories: string[] }>('/academy-settings')
      .then((s) => setCategories(s.categories))
      .catch(() => {});
  }, []);

  // `?course=<id>` is where Ctrl+K lands; keep the URL in step with the modal.
  function show(id: string | 'new' | null) {
    setOpen(id);
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        if (id && id !== 'new') next.set('course', id);
        else next.delete('course');
        return next;
      },
      { replace: true },
    );
  }

  async function startImport() {
    const spec = await loadImportSpec('courses');
    if (!spec) {
      toast('error', 'The course import is not available on this server yet');
      return;
    }
    setImporting(spec);
  }

  const columns: Column<CourseRow>[] = [
    { key: 'code', label: 'Code', sortKey: 'code', width: '120px', render: (r) => <span className="mono">{r.code}</span> },
    {
      key: 'title',
      label: 'Course',
      sortKey: 'title',
      render: (r) => (
        <div>
          <div>{r.title}</div>
          <div className="faint">
            {r.category ?? 'Uncategorised'}
            {r.requiresAssessment ? ' · assessed' : ''}
          </div>
        </div>
      ),
    },
    { key: 'hours', label: 'Hours', sortKey: 'hours', align: 'right', render: (r) => <span className="mono">{r.hours}</span> },
    {
      key: 'validity',
      label: 'Valid for',
      sortKey: 'validityMonths',
      render: (r) => (r.validityMonths ? `${r.validityMonths} months` : <span className="faint">Never expires</span>),
    },
    {
      key: 'requiredOf',
      label: 'Required of',
      render: (r) =>
        r.requiredOf.length ? (
          r.requiredOf.join('; ')
        ) : (
          <span className="faint">Nobody — optional</span>
        ),
    },
    {
      key: 'sessions',
      label: 'Upcoming',
      align: 'right',
      optional: true,
      render: (r) => <span className="mono">{r.upcomingSessions}</span>,
    },
    {
      key: 'completions',
      label: 'Certified',
      align: 'right',
      render: (r) => <span className="mono">{r.completions}</span>,
    },
    {
      key: 'active',
      label: 'Status',
      render: (r) => (
        <StatusBadge status={r.isActive ? 'ACTIVE' : 'INACTIVE'} extra={ACTIVE_TONES} label={r.isActive ? 'Active' : 'Inactive'} />
      ),
    },
  ];

  const newButton = can('ghr.courses.create') ? (
    <button type="button" className="btn btn-primary btn-sm" onClick={() => show('new')}>
      + New course
    </button>
  ) : null;

  return (
    <div>
      <div className="page-head">
        <h1>Courses</h1>
      </div>

      <DataList<CourseRow>
        listKey="hr-courses"
        endpoint="/courses"
        printPath="/api/courses/pdf"
        columns={columns}
        rowKey={(r) => r.id}
        reloadToken={reload}
        initialFilters={{ active: 'true' }}
        searchPlaceholder="Search code, title, category…"
        emptyTitle="No courses yet"
        emptyHint="Add the courses people must hold — safety inductions, equipment tickets, quality training."
        emptyAction={newButton}
        onRowClick={(r) => show(r.id)}
        filters={[
          {
            key: 'active',
            label: 'Status',
            options: [
              { value: 'true', label: 'Active' },
              { value: 'false', label: 'Inactive' },
            ],
          },
          { key: 'category', label: 'Category', options: categories.map((c) => ({ value: c, label: c })) },
          {
            key: 'required',
            label: 'Required',
            options: [
              { value: 'true', label: 'Required of somebody' },
              { value: 'false', label: 'Optional' },
            ],
          },
        ]}
        actions={newButton}
        menuItems={
          can('ghr.courses.create')
            ? [
                {
                  label: 'Import courses…',
                  hint: 'From a CSV, checked before anything is saved',
                  onSelect: () => void startImport(),
                },
              ]
            : []
        }
      />

      {open && (
        <CourseModal
          id={open === 'new' ? null : open}
          categories={categories}
          onClose={() => show(null)}
          onChanged={() => setReload((n) => n + 1)}
        />
      )}
      {importing && (
        <ImportModal
          entity="courses"
          label={importing.label}
          columns={importing.columns}
          onClose={() => setImporting(null)}
          onImported={() => {
            setImporting(null);
            setReload((n) => n + 1);
          }}
        />
      )}
    </div>
  );
}

type Tab = 'details' | 'requirements';

/** A new course's form, and what "unchanged" means before it is saved. */
const BLANK_COURSE = {
  code: '',
  title: '',
  category: '',
  description: '',
  hours: '8',
  validityMonths: '',
  requiresAssessment: false,
  isActive: true,
};

function CourseModal({
  id,
  categories,
  onClose,
  onChanged,
}: {
  id: string | null;
  categories: string[];
  onClose: () => void;
  onChanged: () => void;
}) {
  const { can } = useAuth();
  const toast = useToast();
  const [courseId, setCourseId] = useState<string | null>(id);
  const [course, setCourse] = useState<CourseDetail | null>(null);
  const [tab, setTab] = useState<Tab>('details');
  const [loading, setLoading] = useState(Boolean(id));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const editable = courseId ? can('ghr.courses.edit_all') : can('ghr.courses.create');

  const [form, setForm] = useState(BLANK_COURSE);
  /** The details as last loaded or saved: the form is "changed" only against these. */
  const [savedForm, setSavedForm] = useState(BLANK_COURSE);
  const [reqs, setReqs] = useState<Requirement[]>([]);
  const [reqsDirty, setReqsDirty] = useState(false);
  /**
   * Saves made while the modal is open. The modal stays open after one, so it
   * is remounted under a new key: the shared Modal's "Close without saving?"
   * then counts only what was typed since, and the foot reads Close while
   * nothing is unsaved.
   */
  const [saves, setSaves] = useState(0);

  const accept = useCallback((c: CourseDetail) => {
    setCourse(c);
    const next = {
      code: c.code,
      title: c.title,
      category: c.category ?? '',
      description: c.description ?? '',
      hours: String(c.hours),
      validityMonths: c.validityMonths != null ? String(c.validityMonths) : '',
      requiresAssessment: c.requiresAssessment,
      isActive: c.isActive,
    };
    setForm(next);
    setSavedForm(next);
    setReqs(c.requirements.map((r) => ({ departmentId: r.departmentId, positionId: r.positionId, label: r.label })));
    setReqsDirty(false);
  }, []);

  useEffect(() => {
    if (!courseId) return;
    let live = true;
    api
      .get<CourseDetail>(`/courses/${courseId}`)
      .then((c) => live && accept(c))
      .catch((err) => live && setError(err))
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, [courseId, accept]);

  const hours = Number(form.hours);
  const validity = form.validityMonths.trim() ? Number(form.validityMonths) : null;
  const valid =
    form.code.trim().length >= 2 &&
    form.title.trim().length >= 3 &&
    Number.isFinite(hours) &&
    hours >= 0 &&
    (validity === null || (Number.isInteger(validity) && validity > 0));
  const detailsDirty = (Object.keys(form) as (keyof typeof form)[]).some((k) => form[k] !== savedForm[k]);
  const dirty = editable && (detailsDirty || reqsDirty);

  async function saveDetails() {
    setBusy(true);
    setError(null);
    try {
      const payload = {
        code: form.code.trim(),
        title: form.title.trim(),
        category: form.category || null,
        description: form.description.trim() || null,
        hours,
        validityMonths: validity,
        requiresAssessment: form.requiresAssessment,
        isActive: form.isActive,
      };
      if (courseId) {
        accept(await api.patch<CourseDetail>(`/courses/${courseId}`, payload));
        toast('ok', 'Course saved');
      } else {
        const created = await api.post<CourseDetail>('/courses', payload);
        accept(created);
        setCourseId(created.id);
        setTab('requirements');
        toast('ok', 'Course added — now say who must hold it');
      }
      setSaves((n) => n + 1);
      onChanged();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  async function saveRequirements() {
    if (!courseId) return;
    setBusy(true);
    setError(null);
    try {
      accept(
        await api.put<CourseDetail>(
          `/courses/${courseId}/requirements`,
          reqs.map((r) => ({ departmentId: r.departmentId, positionId: r.positionId })),
        ),
      );
      toast('ok', 'Requirements saved');
      setSaves((n) => n + 1);
      onChanged();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  /** Asked in the modal's foot, which shows a refusal and stays open. */
  async function remove() {
    if (!courseId) return;
    await api.del(`/courses/${courseId}`);
    toast('ok', 'Course deleted');
    onChanged();
    onClose();
  }

  const footer = (
    <ModalFoot
      onCancel={onClose}
      cancelLabel={editable && (dirty || saves === 0) ? 'Cancel' : 'Close'}
      busy={busy}
      danger={
        courseId && course && can('ghr.courses.delete')
          ? { label: 'Delete', question: `Delete ${course.code}? It cannot be undone.`, onConfirm: remove }
          : undefined
      }
    >
      {editable &&
        (tab === 'details' ? (
          <button type="button" className="btn btn-primary" onClick={saveDetails} disabled={busy || !valid}>
            {busy ? 'Saving…' : 'Save'}
          </button>
        ) : (
          <button type="button" className="btn btn-primary" onClick={saveRequirements} disabled={busy || !reqsDirty}>
            {busy ? 'Saving…' : 'Save'}
          </button>
        ))}
    </ModalFoot>
  );

  const title = !courseId
    ? 'New course'
    : !course
      ? 'Course'
      : editable
        ? `Modify course ${course.code}`
        : `${course.code} — ${course.title}`;

  return (
    <Modal title={title} onClose={onClose} wide footer={footer} dirty={dirty}>
      <div className="scope-switch academy-tabs" role="tablist" aria-label="Course">
        {(['details', 'requirements'] as Tab[]).map((t) => (
          <button
            key={t}
            type="button"
            role="tab"
            aria-selected={tab === t}
            className={tab === t ? 'active' : ''}
            disabled={t === 'requirements' && !courseId}
            onClick={() => setTab(t)}
          >
            {t === 'details' ? 'Details' : `Requirements${course ? ` (${course.requirements.length})` : ' — add the course first'}`}
          </button>
        ))}
      </div>
      <ErrorBox error={error} />

      {loading ? (
        <Loading />
      ) : tab === 'details' ? (
        <fieldset className="academy-fieldset" disabled={!editable}>
          <div className="grid grid-2">
            <Field label="Code" required hint="Your own short code, e.g. SAF-01.">
              <input value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value })} />
            </Field>
            <Field label="Category">
              <select value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })}>
                <option value="">Uncategorised</option>
                {[...new Set([...categories, ...(form.category ? [form.category] : [])])].map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </Field>
          </div>
          <Field label="Title" required>
            <input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />
          </Field>
          <div className="grid grid-2">
            <Field label="Hours" required>
              <NumberInput kind="count" min={0} step="0.5" value={form.hours} onChange={(e) => setForm({ ...form, hours: e.target.value })} />
            </Field>
            <Field label="Valid for (months)" hint="Blank = never expires. Changing it applies from the next completion.">
              <NumberInput
                kind="count"
                min={1}
                step={1}
                value={form.validityMonths}
                onChange={(e) => setForm({ ...form, validityMonths: e.target.value })}
              />
            </Field>
          </div>
          <Field label="Description">
            <textarea rows={3} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
          </Field>
          <div className="row academy-checks">
            <Checkbox
              checked={form.requiresAssessment}
              onChange={(v) => setForm({ ...form, requiresAssessment: v })}
              label="Assessed — a pass needs a score"
            />
            <Checkbox checked={form.isActive} onChange={(v) => setForm({ ...form, isActive: v })} label="Active" />
          </div>
          {course && (
            <p className="faint">
              {course._count.sessions} session(s) and {course._count.records} training record(s) use this course
              {course._count.sessions || course._count.records ? ' — deactivate it rather than deleting it.' : '.'}
            </p>
          )}
        </fieldset>
      ) : (
        <RequirementsEditor
          rows={reqs}
          editable={editable}
          onChange={(rows) => {
            setReqs(rows);
            setReqsDirty(true);
          }}
        />
      )}
    </Modal>
  );
}

function RequirementsEditor({
  rows,
  editable,
  onChange,
}: {
  rows: Requirement[];
  editable: boolean;
  onChange: (rows: Requirement[]) => void;
}) {
  const [departments, setDepartments] = useState<{ id: string; name: string }[]>([]);
  const [positions, setPositions] = useState<PositionOption[]>([]);
  useEffect(() => {
    api.get<{ id: string; name: string }[]>('/departments').then(setDepartments).catch(() => {});
    api.get<PositionOption[]>('/positions/lookup').then(setPositions).catch(() => {});
  }, []);

  function update(i: number, patch: Partial<Requirement>) {
    onChange(rows.map((r, j) => (j === i ? { ...r, ...patch, label: undefined } : r)));
  }

  return (
    <div className="stack">
      <p className="muted">
        Each row names who must hold this course. A department alone means everyone in it; a
        position alone means every holder of it; both means holders of that position in that
        department. Leave both as “Any” to require it of everyone.
      </p>
      <div className="table-wrap">
        <table className="data">
          <thead>
            <tr>
              <th>Department</th>
              <th>Plantilla position</th>
              {editable && <th aria-label="Remove" />}
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr>
                <td colSpan={editable ? 3 : 2} className="faint">
                  Nobody is required to hold this course — it is optional.
                </td>
              </tr>
            )}
            {rows.map((r, i) => {
              const choices = r.departmentId
                ? positions.filter((p) => !p.departmentId || p.departmentId === r.departmentId || p.id === r.positionId)
                : positions;
              return (
                <tr key={i}>
                  <td>
                    <select
                      aria-label={`Department for row ${i + 1}`}
                      value={r.departmentId ?? ''}
                      disabled={!editable}
                      onChange={(e) => update(i, { departmentId: e.target.value || null })}
                    >
                      <option value="">Any department</option>
                      {departments.map((d) => (
                        <option key={d.id} value={d.id}>
                          {d.name}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td>
                    <select
                      aria-label={`Position for row ${i + 1}`}
                      value={r.positionId ?? ''}
                      disabled={!editable}
                      onChange={(e) => update(i, { positionId: e.target.value || null })}
                    >
                      <option value="">Any position</option>
                      {choices.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.title}
                          {p.departmentName ? ` — ${p.departmentName}` : ''}
                        </option>
                      ))}
                    </select>
                  </td>
                  {editable && (
                    <td>
                      <button
                        type="button"
                        className="btn btn-sm"
                        aria-label={`Remove row ${i + 1}`}
                        onClick={() => onChange(rows.filter((_, j) => j !== i))}
                      >
                        Remove
                      </button>
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {editable && (
        <div>
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => onChange([...rows, { departmentId: null, positionId: null }])}
          >
            + Add requirement
          </button>
        </div>
      )}
    </div>
  );
}
