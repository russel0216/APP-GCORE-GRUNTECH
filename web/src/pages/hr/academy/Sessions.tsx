import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api, downloadBlob, openPdf, qs } from '../../../lib/api';
import { useAuth } from '../../../lib/auth';
import { DataList, type Column } from '../../../components/DataList';
import { RecordHeader } from '../../../components/RecordHeader';
import { PeoplePicker, type Person } from '../../../components/PeoplePicker';
import { MeetLink } from '../../../components/MeetLink';
import { Attachments } from '../../../components/Attachments';
import {
  Empty,
  ErrorBox,
  Field,
  Loading,
  Modal,
  StatusBadge,
  formatDate,
  formatDateTime,
  useToast,
  type Tone,
} from '../../../components/ui';

/**
 * Training sessions — G-HR › Academy (item 13).
 *
 * A session is a course, a trainer, a time and the people on it. The trainer
 * records a result for each attendee and completes it; completion is final
 * and writes a VERIFIED passport entry for everyone who passed. There is no
 * approval step — the trainer's completion is the verification.
 *
 * `SessionModal` is exported for the Training Calendar, which books a session
 * from a day on the grid with the same form.
 */

export const SESSION_TONES: Record<string, Tone> = {
  SCHEDULED: 'info',
  COMPLETED: 'ok',
  CANCELLED: 'danger',
};

export const RESULT_TONES: Record<string, Tone> = {
  PENDING: '',
  PASSED: 'ok',
  FAILED: 'danger',
  NO_SHOW: 'warn',
};

export const RESULT_LABEL: Record<string, string> = {
  PENDING: 'No result yet',
  PASSED: 'Passed',
  FAILED: 'Failed',
  NO_SHOW: 'No show',
};

export interface CourseOption {
  id: string;
  code: string;
  title: string;
  category: string | null;
  hours: number;
  validityMonths: number | null;
  requiresAssessment: boolean;
}

interface UserRef {
  id: string;
  name: string;
  email?: string;
  position?: string | null;
}

interface AttendeeRow {
  id: string;
  employeeId: string;
  employee: {
    id: string;
    employeeNo: string;
    firstName: string;
    lastName: string;
    position: string | null;
    userId: string | null;
    department: { id: string; name: string } | null;
  };
  enrolledAt: string;
  selfEnrolled: boolean;
  enrolledBy: { id: string; name: string } | null;
  result: string | null;
  score: number | null;
}

export interface SessionDetailData {
  id: string;
  number: string;
  status: string;
  courseId: string;
  course: CourseOption & { description: string | null };
  trainerId: string;
  trainer: UserRef;
  provider: string | null;
  startsAt: string;
  endsAt: string;
  venue: string | null;
  meetLink: string | null;
  capacity: number | null;
  notes: string | null;
  icsSequence: number;
  completedAt: string | null;
  cancelReason: string | null;
  createdBy: { id: string; name: string } | null;
  attendees: AttendeeRow[];
  recordCount: number;
  canEdit: boolean;
  seesResults: boolean;
  live: boolean;
  isTrainer: boolean;
  enrolled: boolean;
  myResult: string | null;
  full: boolean;
  canSelfEnrol: boolean;
  canWithdraw: boolean;
  googleCalendarUrl: string | null;
}

interface SessionRow {
  id: string;
  number: string;
  status: string;
  startsAt: string;
  endsAt: string;
  venue: string | null;
  meetLink: string | null;
  capacity: number | null;
  provider: string | null;
  trainer: { id: string; name: string };
  course: { id: string; code: string; title: string };
  attendeeCount: number;
  passedCount: number;
  isTrainer: boolean;
}

interface EmployeeLookup {
  id: string;
  employeeNo: string;
  firstName: string;
  lastName: string;
  position: string | null;
  department: { id: string; name: string } | null;
}

interface UserLookup {
  id: string;
  name: string;
  email: string;
  position: string | null;
  department: { id: string; name: string } | null;
}

/** Local wall-clock value for a datetime-local input. */
export function toLocalInput(d: Date): string {
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
}

/** "Sep 28, 2026, 09:00 AM – 05:00 PM", or both dates when it runs over days. */
export function sessionWhen(startsAt: string, endsAt: string): string {
  const s = new Date(startsAt);
  const e = new Date(endsAt);
  const time = (d: Date) => d.toLocaleTimeString('en-PH', { hour: '2-digit', minute: '2-digit' });
  if (s.toDateString() === e.toDateString()) return `${formatDate(s)}, ${time(s)} – ${time(e)}`;
  return `${formatDateTime(s)} – ${formatDateTime(e)}`;
}

export function useCourseOptions(): CourseOption[] {
  const [rows, setRows] = useState<CourseOption[]>([]);
  useEffect(() => {
    api
      .get<CourseOption[]>('/courses/lookup')
      .then(setRows)
      .catch(() => setRows([]));
  }, []);
  return rows;
}

const toPerson = (e: EmployeeLookup): Person => ({
  id: e.id,
  name: `${e.firstName} ${e.lastName}`,
  sub: [e.employeeNo, e.position].filter(Boolean).join(' · '),
  group: e.department?.name ?? 'No department',
});

/**
 * Employees to enrol. `/employees/lookup` answers fifty at a time, so the
 * picker starts with the first fifty and a name search fetches more into the
 * same list — anybody already ticked stays ticked whatever the search.
 */
function useEmployeePeople(): { people: Person[]; search: (q: string) => void } {
  const [cache, setCache] = useState<Map<string, Person>>(new Map());
  const fetchInto = useCallback((q: string) => {
    api
      .get<EmployeeLookup[]>(`/employees/lookup${qs({ q: q || undefined, active: 'true' })}`)
      .then((rows) =>
        setCache((prev) => {
          const next = new Map(prev);
          for (const r of rows) next.set(r.id, toPerson(r));
          return next;
        }),
      )
      .catch(() => {});
  }, []);
  useEffect(() => fetchInto(''), [fetchInto]);
  const timer = useRef<number | undefined>(undefined);
  const search = useCallback(
    (q: string) => {
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => fetchInto(q.trim()), 250);
    },
    [fetchInto],
  );
  const people = useMemo(
    () => [...cache.values()].sort((a, b) => (a.group ?? '').localeCompare(b.group ?? '') || a.name.localeCompare(b.name)),
    [cache],
  );
  return { people, search };
}

function EmployeePicker({
  value,
  onChange,
  exclude,
  max,
}: {
  value: string[];
  onChange: (ids: string[]) => void;
  exclude?: string[];
  max?: number;
}) {
  const { people, search } = useEmployeePeople();
  return (
    <div className="stack academy-picker">
      <input
        type="search"
        placeholder="Not listed? Search all employees by name or number…"
        aria-label="Search all employees"
        onChange={(e) => search(e.target.value)}
      />
      <PeoplePicker people={people} value={value} onChange={onChange} exclude={exclude} max={max} />
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════
//  LIST
// ════════════════════════════════════════════════════════════════════

export function Sessions() {
  const { can } = useAuth();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const [creating, setCreating] = useState(params.get('new') === '1');
  // `?new=1&courseId=` is where a course's "Schedule a session" lands.
  const [presetCourse] = useState(params.get('courseId') ?? undefined);
  const [reload, setReload] = useState(0);

  const canCreate = can('ghr.training_sessions.create');

  function closeCreate() {
    setCreating(false);
    if (params.get('new') || params.get('courseId')) {
      const next = new URLSearchParams(params);
      next.delete('new');
      next.delete('courseId');
      setParams(next, { replace: true });
    }
  }

  const columns: Column<SessionRow>[] = [
    {
      key: 'when',
      label: 'When',
      sortKey: 'startsAt',
      width: '230px',
      render: (r) => sessionWhen(r.startsAt, r.endsAt),
    },
    {
      key: 'course',
      label: 'Course',
      render: (r) => (
        <div>
          <div>{r.course.title}</div>
          <div className="faint">
            <span className="mono">{r.number}</span> · {r.course.code}
          </div>
        </div>
      ),
    },
    { key: 'trainer', label: 'Trainer', render: (r) => (r.isTrainer ? 'You' : r.trainer.name) },
    {
      key: 'venue',
      label: 'Where',
      render: (r) => r.venue ?? (r.meetLink ? 'Google Meet' : <span className="faint">—</span>),
    },
    {
      key: 'attendees',
      label: 'People',
      align: 'right',
      render: (r) => (
        <span className="mono">
          {r.status === 'COMPLETED' ? `${r.passedCount}/${r.attendeeCount} passed` : r.attendeeCount}
          {r.capacity ? <span className="faint"> of {r.capacity}</span> : null}
        </span>
      ),
    },
    {
      key: 'status',
      label: 'Status',
      sortKey: 'status',
      render: (r) => <StatusBadge status={r.status} extra={SESSION_TONES} />,
    },
  ];

  const newButton = canCreate ? (
    <button type="button" className="btn btn-primary btn-sm" onClick={() => setCreating(true)}>
      + Schedule session
    </button>
  ) : null;

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Training Sessions</h1>
          <p>
            Scheduled courses, who is on them and how they did. Completing a session writes the
            result straight into each attendee's training passport.
          </p>
        </div>
        <Link className="btn btn-sm" to="/g-hr/academy/calendar">
          Calendar
        </Link>
      </div>

      <DataList<SessionRow>
        listKey="hr-training-sessions"
        endpoint="/training-sessions"
        columns={columns}
        rowKey={(r) => r.id}
        scoped
        reloadToken={reload}
        initialFilters={{ when: 'upcoming' }}
        searchPlaceholder="Search course, number, venue, trainer…"
        emptyTitle="No sessions"
        emptyHint="Sessions you train, schedule or attend appear here."
        emptyAction={newButton}
        onRowClick={(r) => navigate(`/g-hr/academy/sessions/${r.id}`)}
        filters={[
          {
            key: 'when',
            label: 'When',
            options: [
              { value: 'upcoming', label: 'Upcoming' },
              { value: 'to_complete', label: 'Waiting to be completed' },
              { value: 'past', label: 'Past' },
            ],
          },
          {
            key: 'status',
            label: 'Status',
            options: [
              { value: 'SCHEDULED', label: 'Scheduled' },
              { value: 'COMPLETED', label: 'Completed' },
              { value: 'CANCELLED', label: 'Cancelled' },
            ],
          },
        ]}
        actions={newButton}
      />

      {creating && (
        <SessionModal
          courseId={presetCourse}
          onClose={closeCreate}
          onSaved={(id) => {
            closeCreate();
            setReload((n) => n + 1);
            navigate(`/g-hr/academy/sessions/${id}`);
          }}
        />
      )}
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════
//  CREATE / EDIT
// ════════════════════════════════════════════════════════════════════

export function SessionModal({
  initial,
  startAt,
  courseId,
  onClose,
  onSaved,
}: {
  initial?: SessionDetailData;
  /** A session booked from a day on the calendar starts there. */
  startAt?: Date;
  /** Pre-selects a course (from the Courses screen). */
  courseId?: string;
  onClose: () => void;
  onSaved: (id: string) => void;
}) {
  const { me, can } = useAuth();
  const toast = useToast();
  const courses = useCourseOptions();
  const [trainers, setTrainers] = useState<UserLookup[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const editing = Boolean(initial);

  // Choosing somebody else to train is HR's; a trainer schedules their own.
  const canPickTrainer = can('ghr.training_sessions.edit_all');
  useEffect(() => {
    if (!canPickTrainer) return;
    api
      .get<UserLookup[]>(`/users/lookup${qs({ holding: 'ghr.training_sessions.create' })}`)
      .then(setTrainers)
      .catch(() => setTrainers([]));
  }, [canPickTrainer]);

  const defaultStart = useMemo(() => {
    if (startAt) return startAt;
    const d = new Date();
    d.setDate(d.getDate() + 1);
    d.setHours(9, 0, 0, 0);
    return d;
  }, [startAt]);

  const [form, setForm] = useState({
    courseId: initial?.courseId ?? courseId ?? '',
    trainerId: initial?.trainerId ?? (can('ghr.training_sessions.create') ? me?.user.id ?? '' : ''),
    startsAt: toLocalInput(initial ? new Date(initial.startsAt) : defaultStart),
    endsAt: toLocalInput(initial ? new Date(initial.endsAt) : new Date(defaultStart.getTime() + 8 * 3_600_000)),
    venue: initial?.venue ?? '',
    provider: initial?.provider ?? '',
    capacity: initial?.capacity != null ? String(initial.capacity) : '',
    notes: initial?.notes ?? '',
  });
  const [employeeIds, setEmployeeIds] = useState<string[]>([]);
  const course = courses.find((c) => c.id === form.courseId);

  const endsBeforeStart =
    form.startsAt && form.endsAt && new Date(form.endsAt).getTime() <= new Date(form.startsAt).getTime();
  const capacity = form.capacity.trim() ? Number(form.capacity) : null;
  const valid =
    form.courseId &&
    form.trainerId &&
    form.startsAt &&
    form.endsAt &&
    !endsBeforeStart &&
    (capacity === null || (Number.isInteger(capacity) && capacity > 0));

  /** Moving the start keeps the length. */
  function setStart(value: string) {
    const oldStart = new Date(form.startsAt).getTime();
    const oldEnd = new Date(form.endsAt).getTime();
    const next = new Date(value);
    if (Number.isNaN(next.getTime()) || Number.isNaN(oldStart) || Number.isNaN(oldEnd)) {
      setForm({ ...form, startsAt: value });
      return;
    }
    const length = Math.max(oldEnd - oldStart, 30 * 60_000);
    setForm({ ...form, startsAt: value, endsAt: toLocalInput(new Date(next.getTime() + length)) });
  }

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const payload = {
        courseId: form.courseId,
        trainerId: form.trainerId,
        startsAt: new Date(form.startsAt).toISOString(),
        endsAt: new Date(form.endsAt).toISOString(),
        venue: form.venue.trim() || null,
        provider: form.provider.trim() || null,
        capacity,
        notes: form.notes.trim() || null,
      };
      if (initial) {
        await api.patch(`/training-sessions/${initial.id}`, payload);
        toast('ok', 'Session updated');
        onSaved(initial.id);
      } else {
        const created = await api.post<{ id: string; number: string }>('/training-sessions', { ...payload, employeeIds });
        toast('ok', `Scheduled ${created.number}`);
        onSaved(created.id);
      }
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  }

  const trainerOptions: UserLookup[] = useMemo(() => {
    const list = [...trainers];
    if (initial && !list.some((t) => t.id === initial.trainerId)) {
      list.unshift({ id: initial.trainerId, name: initial.trainer.name, email: '', position: null, department: null });
    }
    if (me && can('ghr.training_sessions.create') && !list.some((t) => t.id === me.user.id)) {
      list.unshift({ id: me.user.id, name: me.user.name, email: me.user.email, position: me.user.position, department: null });
    }
    return list;
  }, [trainers, initial, me, can]);

  return (
    <Modal
      title={editing ? 'Change session' : 'Schedule a training session'}
      onClose={onClose}
      wide
      footer={
        <>
          <button type="button" className="btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="button" className="btn btn-primary" onClick={save} disabled={busy || !valid}>
            {busy ? 'Saving…' : editing ? 'Save changes' : 'Schedule'}
          </button>
        </>
      }
    >
      <ErrorBox error={error} />
      <div className="grid grid-2">
        <Field label="Course" required hint={course ? courseHint(course) : undefined}>
          <select value={form.courseId} onChange={(e) => setForm({ ...form, courseId: e.target.value })}>
            <option value="">Choose a course…</option>
            {courses.map((c) => (
              <option key={c.id} value={c.id}>
                {c.code} — {c.title}
              </option>
            ))}
          </select>
        </Field>
        <Field
          label="Trainer"
          required
          hint={canPickTrainer ? 'People holding the Trainer right.' : 'You train the sessions you schedule.'}
        >
          <select
            value={form.trainerId}
            onChange={(e) => setForm({ ...form, trainerId: e.target.value })}
            disabled={!canPickTrainer}
          >
            <option value="">Choose a trainer…</option>
            {trainerOptions.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
                {t.department ? ` — ${t.department.name}` : ''}
              </option>
            ))}
          </select>
        </Field>
      </div>

      <div className="grid grid-2">
        <Field label="Starts" required>
          <input type="datetime-local" value={form.startsAt} onChange={(e) => setStart(e.target.value)} />
        </Field>
        <Field label="Ends" required error={endsBeforeStart ? 'It ends before it starts' : null}>
          <input type="datetime-local" value={form.endsAt} onChange={(e) => setForm({ ...form, endsAt: e.target.value })} />
        </Field>
      </div>

      <div className="grid grid-3">
        <Field label="Venue" hint="A room or a site; blank for an online session.">
          <input value={form.venue} onChange={(e) => setForm({ ...form, venue: e.target.value })} placeholder="Training room" />
        </Field>
        <Field label="Provider" hint="Blank = in-house.">
          <input value={form.provider} onChange={(e) => setForm({ ...form, provider: e.target.value })} />
        </Field>
        <Field label="Capacity" hint="Blank = no limit.">
          <input
            type="number"
            min={1}
            step={1}
            value={form.capacity}
            onChange={(e) => setForm({ ...form, capacity: e.target.value })}
          />
        </Field>
      </div>

      <Field label="Notes" hint="What to bring, pre-reading — goes into the calendar invitation.">
        <textarea rows={3} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
      </Field>

      {!editing && (
        <Field label="Enrol" hint="Each person with a login is told they are on it.">
          <EmployeePicker value={employeeIds} onChange={setEmployeeIds} max={capacity ?? undefined} />
        </Field>
      )}
      {editing && (
        <p className="muted">
          Moving the time or changing the course tells everyone enrolled. Add or remove people from
          the session page.
        </p>
      )}
    </Modal>
  );
}

function courseHint(c: CourseOption): string {
  return [
    `${c.hours} h`,
    c.validityMonths ? `valid ${c.validityMonths} months` : 'never expires',
    c.requiresAssessment ? 'assessed — scores required' : null,
  ]
    .filter(Boolean)
    .join(' · ');
}

// ════════════════════════════════════════════════════════════════════
//  DETAIL
// ════════════════════════════════════════════════════════════════════

type Draft = Record<string, { result: string; score: string }>;

function draftFrom(s: SessionDetailData): Draft {
  const out: Draft = {};
  for (const a of s.attendees) {
    out[a.employeeId] = { result: a.result ?? 'PENDING', score: a.score != null ? String(a.score) : '' };
  }
  return out;
}

export function SessionDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { can } = useAuth();
  const toast = useToast();

  const [session, setSession] = useState<SessionDetailData | null>(null);
  const [draft, setDraft] = useState<Draft>({});
  const [dirty, setDirty] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [editing, setEditing] = useState(false);
  const [adding, setAdding] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [completing, setCompleting] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  const accept = useCallback((s: SessionDetailData) => {
    setSession(s);
    setDraft(draftFrom(s));
    setDirty(false);
  }, []);

  const load = useCallback(async () => {
    if (!id) return;
    try {
      accept(await api.get<SessionDetailData>(`/training-sessions/${id}`));
      setError(null);
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  }, [id, accept]);

  useEffect(() => {
    void load();
  }, [load]);

  async function run(key: string, fn: () => Promise<void>) {
    setBusy(key);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(null);
    }
  }

  if (loading) return <Loading />;
  if (!session) return <ErrorBox error={error ?? new Error('Session not found')} />;

  const s = session;
  const scheduled = s.status === 'SCHEDULED';
  const started = new Date(s.startsAt).getTime() <= Date.now();
  const canPrint = s.canEdit || s.isTrainer || can('ghr.training_sessions.view_all');
  const resultsPayload = () =>
    s.attendees.map((a) => ({
      employeeId: a.employeeId,
      result: draft[a.employeeId]?.result ?? 'PENDING',
      score: draft[a.employeeId]?.score?.trim() ? Number(draft[a.employeeId].score) : null,
    }));
  const pending = resultsPayload().filter((r) => r.result === 'PENDING').length;

  function setResult(employeeId: string, patch: Partial<{ result: string; score: string }>) {
    setDraft((prev) => ({ ...prev, [employeeId]: { ...prev[employeeId], ...patch } }));
    setDirty(true);
  }

  async function saveResults() {
    await run('results', async () => {
      accept(await api.put<SessionDetailData>(`/training-sessions/${s.id}/results`, { results: resultsPayload() }));
      toast('ok', 'Results saved');
    });
  }

  async function removeAttendee(a: AttendeeRow) {
    await run(`remove:${a.employeeId}`, async () => {
      accept(await api.del<SessionDetailData>(`/training-sessions/${s.id}/attendees/${a.employeeId}`));
    });
  }

  async function enrolMe(on: boolean) {
    await run('enrol', async () => {
      accept(
        on
          ? await api.post<SessionDetailData>(`/training-sessions/${s.id}/enrol-me`)
          : await api.del<SessionDetailData>(`/training-sessions/${s.id}/enrol-me`),
      );
      toast('ok', on ? 'You are enrolled' : 'You are off the session');
    });
  }

  async function remove() {
    if (!window.confirm('Delete this session? Nobody is enrolled, so nobody needs telling.')) return;
    await run('delete', async () => {
      await api.del(`/training-sessions/${s.id}`);
      toast('ok', 'Session deleted');
      navigate('/g-hr/academy/sessions');
    });
  }

  async function saveLink(googleUrl: string) {
    accept(await api.patch<SessionDetailData>(`/training-sessions/${s.id}`, { googleUrl }));
  }

  return (
    <div className="academy-page">
      <div className="breadcrumb">
        <Link to="/g-hr/academy/sessions">Training Sessions</Link>
        <span className="sep">›</span>
        <span className="mono">{s.number}</span>
      </div>

      <RecordHeader
        type="Training Session"
        code={s.number}
        title={s.course.title}
        status={s.status}
        statusExtra={SESSION_TONES}
        actions={
          <>
            {s.live && s.meetLink && (
              <a className="btn btn-primary" href={s.meetLink} target="_blank" rel="noopener noreferrer">
                Join now
              </a>
            )}
            {s.canSelfEnrol && (
              <button type="button" className="btn btn-ok" onClick={() => enrolMe(true)} disabled={busy === 'enrol'}>
                Enrol me
              </button>
            )}
            {s.canWithdraw && (
              <button type="button" className="btn" onClick={() => enrolMe(false)} disabled={busy === 'enrol'}>
                Withdraw
              </button>
            )}
            <button
              type="button"
              className="btn"
              disabled={busy === 'ics'}
              onClick={() => run('ics', () => downloadBlob(`/training-sessions/${s.id}/ics`, `${s.number}.ics`))}
            >
              Add to calendar (.ics)
            </button>
            {canPrint && (
              <button
                type="button"
                className="btn"
                onClick={() =>
                  openPdf(`/api/training-sessions/${s.id}/pdf`, () => toast('error', 'Could not open the attendance sheet'))
                }
              >
                Attendance sheet
              </button>
            )}
            {s.canEdit && (
              <button type="button" className="btn" onClick={() => setEditing(true)}>
                Change
              </button>
            )}
            {s.canEdit && (
              <button type="button" className="btn btn-danger" onClick={() => setCancelling(true)}>
                Cancel session
              </button>
            )}
            {s.canEdit && s.attendees.length === 0 && (
              <button type="button" className="btn btn-ghost" onClick={remove} disabled={busy === 'delete'}>
                Delete
              </button>
            )}
          </>
        }
      />

      <p className="record-head-meta academy-meta">
        <strong>{sessionWhen(s.startsAt, s.endsAt)}</strong> · trained by {s.isTrainer ? 'you' : s.trainer.name}
        {s.venue ? ` · ${s.venue}` : s.meetLink ? ' · online' : ''}
        {s.provider ? ` · ${s.provider}` : ''}
        {s.capacity ? ` · ${s.attendees.length} of ${s.capacity} places taken` : ''}
      </p>

      <ErrorBox error={error} />

      {s.status === 'CANCELLED' && (
        <div className="alert warn">Cancelled{s.cancelReason ? ` — ${s.cancelReason}` : ''}. Everyone enrolled was told.</div>
      )}
      {s.status === 'COMPLETED' && (
        <div className="alert ok">
          Completed {s.completedAt ? formatDateTime(s.completedAt) : ''} — {s.recordCount} passport{' '}
          {s.recordCount === 1 ? 'entry' : 'entries'} written. Results are final.
        </div>
      )}
      {s.canEdit && started && scheduled && (
        <div className="alert info">
          This session has started. Record a result for everyone, then press <strong>Complete session</strong>{' '}
          to write the passports.
        </div>
      )}
      {s.enrolled && !s.seesResults && s.myResult && s.myResult !== 'PENDING' && (
        <div className="alert info">
          Your result: <StatusBadge status={s.myResult} extra={RESULT_TONES} label={RESULT_LABEL[s.myResult]} />
        </div>
      )}

      <div className="grid grid-2 academy-body">
        <div className="stack">
          <div className="card">
            <h3 className="card-title">Google Meet</h3>
            <MeetLink
              meetLink={s.meetLink}
              googleCalendarUrl={s.googleCalendarUrl}
              canEdit={s.canEdit}
              onSave={saveLink}
              live={s.live}
            />
          </div>
          <div className="card">
            <h3 className="card-title">Course</h3>
            <dl className="kv">
              <dt>Code</dt>
              <dd className="mono">{s.course.code}</dd>
              <dt>Category</dt>
              <dd>{s.course.category ?? '—'}</dd>
              <dt>Hours</dt>
              <dd>{s.course.hours}</dd>
              <dt>Valid for</dt>
              <dd>{s.course.validityMonths ? `${s.course.validityMonths} months` : 'Never expires'}</dd>
              <dt>Assessed</dt>
              <dd>{s.course.requiresAssessment ? 'Yes — a score is required' : 'No'}</dd>
            </dl>
            {s.course.description && <p className="academy-prose">{s.course.description}</p>}
            {s.notes && (
              <>
                <h4 className="section-label">Notes</h4>
                <p className="academy-prose">{s.notes}</p>
              </>
            )}
          </div>
        </div>

        <div className="card">
          <div className="row academy-split">
            <h3 className="card-title academy-flush">
              People <span className="faint">{s.attendees.length}</span>
            </h3>
            {s.canEdit && (
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => setAdding(true)}
                disabled={s.full}
                title={s.full ? 'The session is full' : undefined}
              >
                + Enrol people
              </button>
            )}
          </div>

          {s.attendees.length === 0 ? (
            <Empty
              title="Nobody enrolled yet"
              hint={s.canEdit ? 'Add the people who should attend.' : 'Nobody is on this session yet.'}
            />
          ) : (
            <div className="table-wrap">
              <table className="data academy-attendees">
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Result</th>
                    {s.course.requiresAssessment && <th className="right">Score</th>}
                    {s.canEdit && <th className="academy-col-actions" aria-label="Remove" />}
                  </tr>
                </thead>
                <tbody>
                  {s.attendees.map((a) => {
                    const name = `${a.employee.firstName} ${a.employee.lastName}`;
                    const d = draft[a.employeeId] ?? { result: 'PENDING', score: '' };
                    return (
                      <tr key={a.id}>
                        <td>
                          <div>{name}</div>
                          <div className="faint">
                            {[a.employee.employeeNo, a.employee.position, a.employee.department?.name].filter(Boolean).join(' · ')}
                            {a.selfEnrolled ? ' · self-enrolled' : ''}
                          </div>
                        </td>
                        <td>
                          {s.canEdit ? (
                            <select
                              aria-label={`Result for ${name}`}
                              value={d.result}
                              onChange={(e) => setResult(a.employeeId, { result: e.target.value })}
                            >
                              {Object.keys(RESULT_LABEL).map((k) => (
                                <option key={k} value={k}>
                                  {RESULT_LABEL[k]}
                                </option>
                              ))}
                            </select>
                          ) : a.result ? (
                            <StatusBadge status={a.result} extra={RESULT_TONES} label={RESULT_LABEL[a.result]} />
                          ) : (
                            <span className="faint">—</span>
                          )}
                        </td>
                        {s.course.requiresAssessment && (
                          <td className="right">
                            {s.canEdit ? (
                              <input
                                className="academy-score"
                                type="number"
                                min={0}
                                max={100}
                                step="0.5"
                                aria-label={`Score for ${name}`}
                                value={d.score}
                                onChange={(e) => setResult(a.employeeId, { score: e.target.value })}
                              />
                            ) : a.score != null ? (
                              <span className="mono">{a.score}</span>
                            ) : (
                              <span className="faint">—</span>
                            )}
                          </td>
                        )}
                        {s.canEdit && (
                          <td>
                            <button
                              type="button"
                              className="btn btn-ghost btn-sm"
                              aria-label={`Remove ${name}`}
                              disabled={busy === `remove:${a.employeeId}`}
                              onClick={() => removeAttendee(a)}
                            >
                              ✕
                            </button>
                          </td>
                        )}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          {s.canEdit && s.attendees.length > 0 && (
            <div className="row academy-actions">
              <button type="button" className="btn btn-sm" onClick={saveResults} disabled={!dirty || busy === 'results'}>
                {busy === 'results' ? 'Saving…' : 'Save results'}
              </button>
              <button
                type="button"
                className="btn btn-primary btn-sm"
                onClick={() => setCompleting(true)}
                disabled={!started || pending > 0}
                title={!started ? 'It has not started yet' : pending ? `${pending} still without a result` : undefined}
              >
                Complete session
              </button>
              {(!started || pending > 0) && (
                <span className="faint">
                  {!started ? 'Opens once the session starts.' : `${pending} attendee(s) still need a result.`}
                </span>
              )}
            </div>
          )}
        </div>
      </div>

      <div className="academy-attachments">
        <Attachments
          entityType="training_session"
          entityId={s.id}
          title="Materials"
          hint="Slides, handouts, the signed attendance sheet, photos of the practical."
          canEdit={s.canEdit || s.isTrainer}
        />
      </div>

      {editing && (
        <SessionModal
          initial={s}
          onClose={() => setEditing(false)}
          onSaved={() => {
            setEditing(false);
            void load();
          }}
        />
      )}
      {adding && (
        <EnrolModal
          session={s}
          onClose={() => setAdding(false)}
          onDone={(next) => {
            setAdding(false);
            accept(next);
          }}
        />
      )}
      {cancelling && (
        <CancelModal
          session={s}
          onClose={() => setCancelling(false)}
          onDone={(next) => {
            setCancelling(false);
            accept(next);
          }}
        />
      )}
      {completing && (
        <CompleteModal
          session={s}
          results={resultsPayload()}
          onClose={() => setCompleting(false)}
          onDone={(next) => {
            setCompleting(false);
            accept(next);
          }}
        />
      )}
    </div>
  );
}

function EnrolModal({
  session,
  onClose,
  onDone,
}: {
  session: SessionDetailData;
  onClose: () => void;
  onDone: (s: SessionDetailData) => void;
}) {
  const toast = useToast();
  const [ids, setIds] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const exclude = useMemo(() => session.attendees.map((a) => a.employeeId), [session]);
  const room = session.capacity != null ? Math.max(0, session.capacity - session.attendees.length) : undefined;

  async function add() {
    setBusy(true);
    setError(null);
    try {
      const next = await api.post<SessionDetailData>(`/training-sessions/${session.id}/attendees`, { employeeIds: ids });
      toast('ok', `${ids.length} enrolled`);
      onDone(next);
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  }

  return (
    <Modal
      title="Enrol people"
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="button" className="btn btn-primary" onClick={add} disabled={busy || ids.length === 0}>
            {busy ? 'Enrolling…' : `Enrol ${ids.length || ''}`.trim()}
          </button>
        </>
      }
    >
      <ErrorBox error={error} />
      {room !== undefined && <p className="muted">Room for {room} more.</p>}
      <EmployeePicker value={ids} onChange={setIds} exclude={exclude} max={room} />
    </Modal>
  );
}

function CancelModal({
  session,
  onClose,
  onDone,
}: {
  session: SessionDetailData;
  onClose: () => void;
  onDone: (s: SessionDetailData) => void;
}) {
  const toast = useToast();
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  async function cancel() {
    setBusy(true);
    setError(null);
    try {
      const next = await api.post<SessionDetailData>(`/training-sessions/${session.id}/cancel`, { reason: reason.trim() });
      toast('ok', 'Session cancelled');
      onDone(next);
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  }

  return (
    <Modal
      title="Cancel this session"
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose} disabled={busy}>
            Keep it
          </button>
          <button type="button" className="btn btn-danger" onClick={cancel} disabled={busy || reason.trim().length < 3}>
            {busy ? 'Cancelling…' : 'Cancel session'}
          </button>
        </>
      }
    >
      <ErrorBox error={error} />
      <p className="muted">
        {session.attendees.length
          ? `${session.attendees.length} enrolled will be told, with your reason.`
          : 'Nobody is enrolled, so nobody needs telling — the record stays as cancelled.'}
      </p>
      <Field label="Why" required>
        <textarea rows={3} value={reason} onChange={(e) => setReason(e.target.value)} />
      </Field>
    </Modal>
  );
}

function CompleteModal({
  session,
  results,
  onClose,
  onDone,
}: {
  session: SessionDetailData;
  results: { employeeId: string; result: string; score: number | null }[];
  onClose: () => void;
  onDone: (s: SessionDetailData) => void;
}) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const count = (r: string) => results.filter((x) => x.result === r).length;

  async function complete() {
    setBusy(true);
    setError(null);
    try {
      const next = await api.post<SessionDetailData & { outcome: { passed: number } }>(
        `/training-sessions/${session.id}/complete`,
        { results },
      );
      toast('ok', `Completed — ${next.outcome.passed} passport entr${next.outcome.passed === 1 ? 'y' : 'ies'} written`);
      onDone(next);
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  }

  return (
    <Modal
      title="Complete this session"
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose} disabled={busy}>
            Not yet
          </button>
          <button type="button" className="btn btn-primary" onClick={complete} disabled={busy}>
            {busy ? 'Completing…' : 'Complete session'}
          </button>
        </>
      }
    >
      <ErrorBox error={error} />
      <p>
        <strong>{count('PASSED')}</strong> passed · <strong>{count('FAILED')}</strong> failed ·{' '}
        <strong>{count('NO_SHOW')}</strong> no-show.
      </p>
      <p className="muted">
        Everyone who passed gets a verified entry in their training passport
        {session.course.validityMonths ? `, valid for ${session.course.validityMonths} months` : ''}. This is
        final: results cannot be changed afterwards.
      </p>
    </Modal>
  );
}
