import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../../../lib/api';
import { useAuth } from '../../../lib/auth';
import { DataList, type Column } from '../../../components/DataList';
import { ImportModal, loadImportSpec } from '../../../components/ImportModal';
import { ActiveBadge, Checkbox, ErrorBox, Field, Loading, Modal, ModalFoot, formatSpan, useToast } from '../../../components/ui';
import { NumberInput } from '../../../components/NumberInput';
import { Stat } from '../../../components/charts';

/**
 * Courses — the Academy's master (item 13), in the owner's Academy UI
 * (2026-10-20): four cards over the list, each course with its category
 * chip, its trainer and credential, its next session, its duration and the
 * seats left, and "Enroll now" on the row — the viewer joins the course's
 * NEXT open session through the one self-enrolment a session has. A List /
 * Cards switch (`?view=cards`, the inventory's rule) draws the same rows as
 * the spec's featured cards. A row opens the course's own page; the modal
 * is the editor alone.
 *
 * A course says what it is, how long it lasts, whether it is assessed and
 * how long a completion stays valid. Its Requirements say who must hold it:
 * a plantilla position, or — left as "any" — everyone.
 */

export interface NextSession {
  id: string;
  number: string;
  startsAt: string;
  endsAt: string;
  days: number;
  venue: string | null;
  meetLink: string | null;
  capacity: number | null;
  enrolledCount: number;
  seatsLeft: number | null;
  full: boolean;
  enrolledMe: boolean;
  trainer: { id: string; name: string; position: string | null };
  canEnrol: boolean;
}

export interface CourseRow {
  id: string;
  code: string;
  title: string;
  category: string | null;
  categoryColor: string | null;
  description: string | null;
  hours: number;
  validityMonths: number | null;
  requiresAssessment: boolean;
  isActive: boolean;
  certificateIncluded: boolean;
  requirementCount: number;
  requiredOf: string[];
  upcomingSessions: number;
  completions: number;
  nextSession: NextSession | null;
  trainerName: string | null;
  trainerCredential: string | null;
  duration: string;
  seatsLeft: number | null;
  enrolled: boolean;
  canEnrol: boolean;
}

interface CourseSummary {
  activeCourses: number;
  enrolledPeople: number;
  enrolledSessions: number;
  upcomingWeek: number;
  completedHours: number;
  completedThisYear: number;
}

export interface Requirement {
  id?: string;
  /** Only on a requirement stored before the department went — kept as it is, or removed. */
  departmentId: string | null;
  department?: { id: string; name: string } | null;
  positionId: string | null;
  label?: string;
}

export interface CourseModule {
  id?: string;
  sequence?: number;
  title: string;
  topics: string[];
}

export interface CourseDetail {
  id: string;
  code: string;
  title: string;
  category: string | null;
  categoryColor: string | null;
  description: string | null;
  hours: number;
  validityMonths: number | null;
  requiresAssessment: boolean;
  isActive: boolean;
  instructor: string | null;
  instructorCredential: string | null;
  format: string | null;
  certificateIncluded: boolean;
  modules: CourseModule[];
  requirements: Requirement[];
  upcoming: NextSession[];
  duration: string;
  enrolled: boolean;
  canEnrol: boolean;
  selfEnrolment: boolean;
  createdAt: string;
  _count: { sessions: number; records: number };
  /** Edit All, or Edit Own on a course the viewer added (2026-10-18) — the API says. */
  canEdit?: boolean;
}

interface PositionOption {
  id: string;
  code: string;
  title: string;
  level: number | null;
}

/** The category's chip, in its own colour. */
export function CategoryChip({ name, color }: { name: string | null; color: string | null }) {
  if (!name) return <span className="tag">Uncategorised</span>;
  return (
    <span className="tag academy-chip" style={color ? ({ '--chip-color': color } as React.CSSProperties) : undefined}>
      {name}
    </span>
  );
}

/** "4 / 20 seats", red at two or fewer; "Open" with no cap; "Full". */
export function SeatsLeft({ session }: { session: NextSession | null }) {
  if (!session) return <span className="faint">No session scheduled</span>;
  if (session.seatsLeft == null) return <span>{session.enrolledCount} enrolled · open</span>;
  if (session.full) return <span className="academy-low">Full · {session.capacity} seats</span>;
  return (
    <span className={session.seatsLeft <= 2 ? 'academy-low' : undefined}>
      {session.seatsLeft} / {session.capacity} seats
    </span>
  );
}

/** The "Enroll now" button and its two other states — one piece for the row, the card and the page. */
export function EnrolButton({
  course,
  small,
  onEnrolled,
}: {
  course: Pick<CourseRow, 'id' | 'code' | 'nextSession' | 'enrolled' | 'canEnrol'>;
  small?: boolean;
  onEnrolled?: () => void;
}) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const cls = small ? 'btn btn-sm' : 'btn';
  if (course.enrolled) {
    return (
      <button type="button" className={cls} disabled>
        ✓ Enrolled
      </button>
    );
  }
  if (!course.nextSession) {
    return (
      <button type="button" className={cls} disabled title="No session is scheduled yet">
        No session
      </button>
    );
  }
  if (course.nextSession.full) {
    return (
      <button type="button" className={cls} disabled title="Every seat on the next session is taken">
        Full
      </button>
    );
  }
  if (!course.canEnrol) {
    return (
      <button type="button" className={cls} disabled title="Self-enrolment is off, or your login has no active employee record">
        Enroll now
      </button>
    );
  }
  return (
    <button
      type="button"
      className={`${cls} btn-primary`}
      disabled={busy}
      onClick={async (e) => {
        e.stopPropagation();
        setBusy(true);
        try {
          await api.post(`/courses/${course.id}/enrol-me`, {});
          toast('ok', `You are enrolled on ${course.code}`);
          onEnrolled?.();
        } catch (err) {
          toast('error', err instanceof Error ? err.message : 'Could not enrol');
        } finally {
          setBusy(false);
        }
      }}
    >
      {busy ? 'Enrolling…' : 'Enroll now'}
    </button>
  );
}

const COURSES_VIEW_KEY = 'gcore_view_courses';
type CoursesView = 'list' | 'cards';
function storedCoursesView(): CoursesView {
  try {
    return localStorage.getItem(COURSES_VIEW_KEY) === 'cards' ? 'cards' : 'list';
  } catch {
    return 'list';
  }
}

export function Courses() {
  const { can } = useAuth();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const [open, setOpen] = useState<string | 'new' | null>(params.get('course'));
  const [importing, setImporting] = useState<{ label: string; columns: { header: string; required?: boolean; example?: string; hint?: string }[] } | null>(null);
  const [categories, setCategories] = useState<string[]>([]);
  const [reload, setReload] = useState(0);
  const toast = useToast();
  const asked = params.get('view');
  const view: CoursesView = asked === 'cards' || asked === 'list' ? asked : storedCoursesView();

  function chooseView(next: CoursesView) {
    try {
      localStorage.setItem(COURSES_VIEW_KEY, next);
    } catch {
      // A browser that keeps nothing still switches; it just will not remember.
    }
    const p = new URLSearchParams(params);
    p.set('view', next);
    setParams(p, { replace: true });
  }

  useEffect(() => {
    api
      .get<{ categories: string[] }>('/academy-settings')
      .then((s) => setCategories(s.categories))
      .catch(() => {});
  }, []);

  // `?course=<id>` is where an old link lands: the course has a page now.
  useEffect(() => {
    const id = params.get('course');
    if (id) navigate(`/g-hr/academy/courses/${id}`, { replace: true });
  }, [params, navigate]);

  async function startImport() {
    const spec = await loadImportSpec('courses');
    if (!spec) {
      toast('error', 'The course import is not available on this server yet');
      return;
    }
    setImporting(spec);
  }

  const refresh = () => setReload((n) => n + 1);

  const columns: Column<CourseRow>[] = [
    {
      key: 'title',
      label: 'Course title & category',
      sortKey: 'title',
      render: (r) => (
        <div className="academy-course-cell">
          <div className="academy-course-title">{r.title}</div>
          <CategoryChip name={r.category} color={r.categoryColor} />
        </div>
      ),
    },
    {
      key: 'trainer',
      label: 'Trainer / instructor',
      render: (r) =>
        r.trainerName ? (
          <div>
            <div>{r.trainerName}</div>
            {r.trainerCredential && <div className="faint">{r.trainerCredential}</div>}
          </div>
        ) : (
          <span className="faint">—</span>
        ),
    },
    {
      key: 'schedule',
      label: 'Schedule date',
      render: (r) =>
        r.nextSession ? (
          <div>
            <div>{formatSpan(r.nextSession.startsAt, r.nextSession.endsAt)}</div>
            <div className="faint">{r.nextSession.number}</div>
          </div>
        ) : (
          <span className="faint">None scheduled</span>
        ),
    },
    { key: 'duration', label: 'Duration', sortKey: 'hours', render: (r) => r.duration },
    { key: 'seats', label: 'Seats left', render: (r) => <SeatsLeft session={r.nextSession} /> },
    {
      key: 'action',
      label: 'Action',
      render: (r) => (
        <span onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
          <EnrolButton course={r} small onEnrolled={refresh} />
        </span>
      ),
    },
    { key: 'code', label: 'Code', sortKey: 'code', optional: true, render: (r) => <span className="mono">{r.code}</span> },
    {
      key: 'validity',
      label: 'Valid for',
      sortKey: 'validityMonths',
      optional: true,
      render: (r) => (r.validityMonths ? `${r.validityMonths} months` : <span className="faint">Never expires</span>),
    },
    {
      key: 'requiredOf',
      label: 'Required of',
      optional: true,
      render: (r) => (r.requiredOf.length ? r.requiredOf.join('; ') : <span className="faint">Nobody — optional</span>),
    },
    { key: 'completions', label: 'Certified', align: 'right', optional: true, render: (r) => <span className="mono">{r.completions}</span> },
    { key: 'active', label: 'Status', optional: true, render: (r) => <ActiveBadge active={r.isActive} /> },
  ];

  const newButton = can('ghr.courses.create') ? (
    <button type="button" className="btn btn-primary btn-sm" onClick={() => setOpen('new')}>
      + New course
    </button>
  ) : null;

  return (
    <div>
      <div className="page-head">
        <h1>Courses</h1>
        <div className="scope-switch" role="group" aria-label="View">
          <button type="button" className={view === 'list' ? 'active' : ''} aria-pressed={view === 'list'} onClick={() => chooseView('list')}>
            List
          </button>
          <button type="button" className={view === 'cards' ? 'active' : ''} aria-pressed={view === 'cards'} onClick={() => chooseView('cards')}>
            Cards
          </button>
        </div>
      </div>

      <DataList<CourseRow>
        listKey="hr-courses"
        endpoint="/courses"
        printPath="/api/courses/pdf"
        columns={columns}
        rowKey={(r) => r.id}
        reloadToken={reload}
        initialFilters={{ active: 'true' }}
        searchPlaceholder="Search code, title, category, instructor…"
        emptyTitle="No courses yet"
        emptyHint="Add the courses people must hold — safety inductions, equipment tickets, quality training."
        emptyAction={newButton}
        onRowClick={(r) => navigate(`/g-hr/academy/courses/${r.id}`)}
        summary={(raw) => {
          const s = raw as unknown as CourseSummary;
          return (
            <>
              <Stat label="Active courses" value={s.activeCourses ?? 0} sub="Programs" />
              <Stat label="Enrolled" value={s.enrolledPeople ?? 0} sub={`People on ${s.enrolledSessions ?? 0} upcoming session${s.enrolledSessions === 1 ? '' : 's'}`} />
              <Stat label="Upcoming sessions" value={s.upcomingWeek ?? 0} sub="Starting in the next 7 days" />
              <Stat label="Completed hours" value={s.completedHours ?? 0} sub={`Year to date · ${s.completedThisYear ?? 0} completion${s.completedThisYear === 1 ? '' : 's'}`} />
            </>
          );
        }}
        renderRows={
          view === 'cards'
            ? (rows) => (
                <div className="academy-cards">
                  {rows.map((r) => (
                    <CourseCard key={r.id} course={r} onEnrolled={refresh} />
                  ))}
                </div>
              )
            : undefined
        }
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

      {open === 'new' && (
        <CourseModal
          id={null}
          categories={categories}
          onClose={() => setOpen(null)}
          onChanged={refresh}
          onCreated={(id) => navigate(`/g-hr/academy/courses/${id}`)}
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
            refresh();
          }}
        />
      )}
    </div>
  );
}

/** The spec's featured card: chip, status dot, title, description, trainer, date, duration, the foot. */
function CourseCard({ course, onEnrolled }: { course: CourseRow; onEnrolled: () => void }) {
  const s = course.nextSession;
  const status = course.enrolled
    ? { tone: 'ok', text: 'Enrolled' }
    : !s
      ? { tone: 'quiet', text: 'No session scheduled' }
      : s.full
        ? { tone: 'danger', text: 'Full' }
        : s.seatsLeft != null && s.seatsLeft <= 2
          ? { tone: 'warn', text: 'Almost full' }
          : { tone: 'ok', text: 'Open registration' };
  return (
    <article className="card academy-card">
      <div className="academy-card-top">
        <CategoryChip name={course.category} color={course.categoryColor} />
        <span className={`academy-dot is-${status.tone}`}>{status.text}</span>
      </div>
      <h3 className="academy-card-title">
        <Link to={`/g-hr/academy/courses/${course.id}`}>{course.title}</Link>
      </h3>
      {course.description && <p className="academy-card-desc">{course.description}</p>}
      <dl className="kv academy-card-facts">
        <dt>Trainer</dt>
        <dd>{course.trainerName ? [course.trainerName, course.trainerCredential].filter(Boolean).join(' — ') : '—'}</dd>
        <dt>Date</dt>
        <dd>{s ? formatSpan(s.startsAt, s.endsAt) : 'None scheduled'}</dd>
        <dt>Duration</dt>
        <dd>{course.duration}</dd>
      </dl>
      <div className="academy-card-foot">
        <span className="faint">
          {course.enrolled ? 'Passport credited on completion' : course.certificateIncluded ? 'Certificate included' : s && s.seatsLeft != null ? `${s.seatsLeft} seat${s.seatsLeft === 1 ? '' : 's'} left` : ''}
        </span>
        <EnrolButton course={course} small onEnrolled={onEnrolled} />
      </div>
    </article>
  );
}

type Tab = 'details' | 'syllabus' | 'requirements';

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
  instructor: '',
  instructorCredential: '',
  format: '',
  certificateIncluded: false,
};

const FORMATS = ['Workshop', 'Intensive', 'Seminar', 'Webinar', 'Hands-on', 'Certification'];

export function CourseModal({
  id,
  categories,
  onClose,
  onChanged,
  onCreated,
}: {
  id: string | null;
  categories: string[];
  onClose: () => void;
  onChanged: () => void;
  /** A new course saved: the caller opens its page. */
  onCreated?: (id: string) => void;
}) {
  const { can } = useAuth();
  const toast = useToast();
  const [courseId, setCourseId] = useState<string | null>(id);
  const [course, setCourse] = useState<CourseDetail | null>(null);
  const [tab, setTab] = useState<Tab>('details');
  const [loading, setLoading] = useState(Boolean(id));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const editable = courseId ? !!course?.canEdit : can('ghr.courses.create');

  const [form, setForm] = useState(BLANK_COURSE);
  /** The details as last loaded or saved: the form is "changed" only against these. */
  const [savedForm, setSavedForm] = useState(BLANK_COURSE);
  const [reqs, setReqs] = useState<Requirement[]>([]);
  const [reqsDirty, setReqsDirty] = useState(false);
  const [modules, setModules] = useState<CourseModule[]>([]);
  const [modulesDirty, setModulesDirty] = useState(false);
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
      instructor: c.instructor ?? '',
      instructorCredential: c.instructorCredential ?? '',
      format: c.format ?? '',
      certificateIncluded: c.certificateIncluded,
    };
    setForm(next);
    setSavedForm(next);
    setReqs(
      c.requirements.map((r) => ({ departmentId: r.departmentId, department: r.department, positionId: r.positionId, label: r.label })),
    );
    setReqsDirty(false);
    setModules(c.modules.map((m) => ({ id: m.id, title: m.title, topics: [...m.topics] })));
    setModulesDirty(false);
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
  const dirty = editable && (detailsDirty || reqsDirty || modulesDirty);

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
        instructor: form.instructor.trim() || null,
        instructorCredential: form.instructorCredential.trim() || null,
        format: form.format.trim() || null,
        certificateIncluded: form.certificateIncluded,
      };
      if (courseId) {
        accept(await api.patch<CourseDetail>(`/courses/${courseId}`, payload));
        toast('ok', 'Course saved');
      } else {
        const created = await api.post<CourseDetail>('/courses', payload);
        accept(created);
        setCourseId(created.id);
        setTab('syllabus');
        toast('ok', 'Course added — now outline its syllabus and say who must hold it');
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

  async function saveModules() {
    if (!courseId) return;
    setBusy(true);
    setError(null);
    try {
      accept(
        await api.put<CourseDetail>(
          `/courses/${courseId}/modules`,
          modules.filter((m) => m.title.trim()).map((m) => ({ title: m.title.trim(), topics: m.topics.map((t) => t.trim()).filter(Boolean) })),
        ),
      );
      toast('ok', 'Syllabus saved');
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

  function close() {
    // A course made in this modal opens on its page when the modal is closed.
    if (!id && courseId && onCreated) onCreated(courseId);
    else onClose();
  }

  const saveButton =
    tab === 'details' ? (
      <button type="button" className="btn btn-primary" onClick={saveDetails} disabled={busy || !valid}>
        {busy ? 'Saving…' : 'Save'}
      </button>
    ) : tab === 'syllabus' ? (
      <button type="button" className="btn btn-primary" onClick={saveModules} disabled={busy || !modulesDirty}>
        {busy ? 'Saving…' : 'Save'}
      </button>
    ) : (
      <button type="button" className="btn btn-primary" onClick={saveRequirements} disabled={busy || !reqsDirty}>
        {busy ? 'Saving…' : 'Save'}
      </button>
    );

  const footer = (
    <ModalFoot
      onCancel={close}
      cancelLabel={editable && (dirty || saves === 0) ? 'Cancel' : 'Close'}
      busy={busy}
      danger={
        courseId && course && can('ghr.courses.delete')
          ? { label: 'Delete', question: `Delete ${course.code}? It cannot be undone.`, onConfirm: remove }
          : undefined
      }
    >
      {editable && saveButton}
    </ModalFoot>
  );

  const title = !courseId
    ? 'New course'
    : !course
      ? 'Course'
      : editable
        ? `Modify course ${course.code}`
        : `${course.code} — ${course.title}`;

  const tabs: { key: Tab; label: string }[] = [
    { key: 'details', label: 'Details' },
    { key: 'syllabus', label: course ? `Syllabus (${course.modules.length})` : 'Syllabus — add the course first' },
    { key: 'requirements', label: course ? `Requirements (${course.requirements.length})` : 'Requirements — add the course first' },
  ];

  return (
    <Modal title={title} onClose={close} wide footer={footer} dirty={dirty}>
      <div className="scope-switch academy-tabs" role="tablist" aria-label="Course">
        {tabs.map((t) => (
          <button
            key={t.key}
            type="button"
            role="tab"
            aria-selected={tab === t.key}
            className={tab === t.key ? 'active' : ''}
            disabled={t.key !== 'details' && !courseId}
            onClick={() => setTab(t.key)}
          >
            {t.label}
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
            <Field label="Category" hint="The list is Admin › Categories › Course categories.">
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
          <Field label="Description">
            <textarea rows={3} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
          </Field>
          <div className="grid grid-2">
            <Field label="Instructor" hint="The default trainer the list names when no session is scheduled — a login or not.">
              <input value={form.instructor} onChange={(e) => setForm({ ...form, instructor: e.target.value })} />
            </Field>
            <Field label="Credential" hint="e.g. Senior Utilities Specialist, Grundfos Certified Trainer.">
              <input value={form.instructorCredential} onChange={(e) => setForm({ ...form, instructorCredential: e.target.value })} />
            </Field>
          </div>
          <div className="grid grid-2">
            <Field label="Hours" required>
              <NumberInput kind="count" min={0} step="0.5" value={form.hours} onChange={(e) => setForm({ ...form, hours: e.target.value })} />
            </Field>
            <Field label="Format" hint="Said after the days — “2-day Workshop”.">
              <input list="academy-formats" value={form.format} onChange={(e) => setForm({ ...form, format: e.target.value })} />
              <datalist id="academy-formats">
                {FORMATS.map((f) => (
                  <option key={f} value={f} />
                ))}
              </datalist>
            </Field>
          </div>
          <div className="grid grid-2">
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
          <div className="row academy-checks">
            <Checkbox
              checked={form.requiresAssessment}
              onChange={(v) => setForm({ ...form, requiresAssessment: v })}
              label="Assessed — a pass needs a score"
            />
            <Checkbox
              checked={form.certificateIncluded}
              onChange={(v) => setForm({ ...form, certificateIncluded: v })}
              label="Certificate included"
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
      ) : tab === 'syllabus' ? (
        <SyllabusEditor
          rows={modules}
          editable={editable}
          onChange={(rows) => {
            setModules(rows);
            setModulesDirty(true);
          }}
        />
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

/** The syllabus outline: a module's title and its topics, one per line. */
function SyllabusEditor({
  rows,
  editable,
  onChange,
}: {
  rows: CourseModule[];
  editable: boolean;
  onChange: (rows: CourseModule[]) => void;
}) {
  function update(i: number, patch: Partial<CourseModule>) {
    onChange(rows.map((m, j) => (j === i ? { ...m, ...patch } : m)));
  }
  function move(i: number, dir: -1 | 1) {
    const j = i + dir;
    if (j < 0 || j >= rows.length) return;
    const next = [...rows];
    [next[i], next[j]] = [next[j], next[i]];
    onChange(next);
  }
  return (
    <div className="stack">
      <p className="muted">
        The syllabus outline — “Module 1: Air Generation” with its topics. It prints on the course paper and shows on the
        course page.
      </p>
      {rows.length === 0 && <p className="faint">No modules yet.</p>}
      {rows.map((m, i) => (
        <div key={i} className="academy-module">
          <div className="academy-module-head">
            <span className="academy-module-no">Module {i + 1}</span>
            {editable && (
              <span className="row academy-module-tools">
                <button type="button" className="btn btn-sm" aria-label={`Move module ${i + 1} up`} disabled={i === 0} onClick={() => move(i, -1)}>
                  ↑
                </button>
                <button type="button" className="btn btn-sm" aria-label={`Move module ${i + 1} down`} disabled={i === rows.length - 1} onClick={() => move(i, 1)}>
                  ↓
                </button>
                <button type="button" className="btn btn-sm" onClick={() => onChange(rows.filter((_, j) => j !== i))}>
                  Remove
                </button>
              </span>
            )}
          </div>
          <Field label="Title" required>
            <input value={m.title} disabled={!editable} onChange={(e) => update(i, { title: e.target.value })} />
          </Field>
          <Field label="Topics" hint="One per line.">
            <textarea
              rows={3}
              value={m.topics.join('\n')}
              disabled={!editable}
              onChange={(e) => update(i, { topics: e.target.value.split('\n') })}
            />
          </Field>
        </div>
      ))}
      {editable && (
        <div>
          <button type="button" className="btn btn-sm" onClick={() => onChange([...rows, { title: '', topics: [] }])}>
            + Add module
          </button>
        </div>
      )}
    </div>
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
  const [positions, setPositions] = useState<PositionOption[]>([]);
  useEffect(() => {
    api.get<PositionOption[]>('/positions/lookup').then(setPositions).catch(() => {});
  }, []);

  function update(i: number, patch: Partial<Requirement>) {
    onChange(rows.map((r, j) => (j === i ? { ...r, ...patch, label: undefined } : r)));
  }

  return (
    <div className="stack">
      <p className="muted">
        Each row names who must hold this course: every holder of a plantilla position, or —
        left as “Any” — everyone. A row from before the department was retired keeps applying
        until it is removed.
      </p>
      <div className="table-wrap">
        <table className="data">
          <thead>
            <tr>
              <th>Plantilla position</th>
              {editable && <th aria-label="Remove" />}
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr>
                <td colSpan={editable ? 2 : 1} className="faint">
                  Nobody is required to hold this course — it is optional.
                </td>
              </tr>
            )}
            {rows.map((r, i) => {
              // A row from before the department went is shown as it is and
              // can only be removed: the API takes it back unchanged, never edited.
              if (r.departmentId) {
                return (
                  <tr key={i}>
                    <td>
                      {r.label ?? `Department (retired): ${r.department?.name ?? '—'}`}
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
              }
              return (
                <tr key={i}>
                  <td>
                    <select
                      aria-label={`Position for row ${i + 1}`}
                      value={r.positionId ?? ''}
                      disabled={!editable}
                      onChange={(e) => update(i, { positionId: e.target.value || null })}
                    >
                      <option value="">Any position (everyone)</option>
                      {positions.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.title}
                          {p.level != null ? ` — Level ${p.level}` : ''}
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
