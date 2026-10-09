import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api, downloadBlob, qs } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { DataList, type Column } from '../../components/DataList';
import { RecordHeader } from '../../components/RecordHeader';
import { useConfirm } from '../../components/Confirm';
import { PeoplePicker, type Person } from '../../components/PeoplePicker';
import { MeetLink } from '../../components/MeetLink';
import { Attachments } from '../../components/Attachments';
import {
  CalendarToolbar,
  MonthCalendar,
  useCalendarNav,
  type CalendarEvent,
} from '../../components/MonthCalendar';
import { dayKeyOf, parseDay } from '../../lib/day';
import {
  Checkbox,
  Empty,
  ErrorBox,
  Field,
  Loading,
  Modal,
  ModalFoot,
  StatusBadge,
  formatDate,
  formatDateTime,
  statusTone,
  useToast,
  type Tone,
} from '../../components/ui';

/**
 * Meetings — G-HR › My day (item 11).
 *
 * An internal meeting with invitees. G-CORE holds no Google credentials and
 * sends no email: the organiser creates the event in their own calendar from
 * the hand-off link, pastes the Meet link back, and presses "Send
 * invitations" when the list is right — nothing goes out on every save.
 * Anybody invited can pull the `.ics` into whatever calendar they use.
 */

/** Meeting statuses borrow ActivityStatus; the tones are the module's (rule 12). */
export const MEETING_TONES: Record<string, Tone> = {
  PLANNED: 'info',
  DONE: 'ok',
  CANCELLED: 'danger',
};

export const RESPONSE_TONES: Record<string, Tone> = {
  PENDING: '',
  ACCEPTED: 'ok',
  TENTATIVE: 'warn',
  DECLINED: 'danger',
};

const RESPONSE_LABEL: Record<string, string> = {
  PENDING: 'No answer yet',
  ACCEPTED: 'Accepted',
  TENTATIVE: 'Tentative',
  DECLINED: 'Declined',
};

interface UserRef {
  id: string;
  name: string;
  email: string;
  position: string | null;
}

interface MeetingRow {
  id: string;
  number: string;
  title: string;
  location: string | null;
  startsAt: string;
  endsAt: string;
  status: string;
  meetLink: string | null;
  organizer: { id: string; name: string };
  job: { id: string; number: string; name: string } | null;
  inviteeCount: number;
  acceptedCount: number;
  sent: boolean;
  myResponse: string | null;
  isOrganizer: boolean;
}

interface Invitee {
  id: string;
  userId: string;
  required: boolean;
  response: string;
  respondedAt: string | null;
  notifiedAt: string | null;
  user: UserRef;
}

interface Meeting {
  id: string;
  number: string;
  title: string;
  agenda: string | null;
  location: string | null;
  startsAt: string;
  endsAt: string;
  status: string;
  organizerId: string;
  organizer: UserRef;
  job: { id: string; number: string; name: string } | null;
  meetLink: string | null;
  calendarEventUrl: string | null;
  icsSequence: number;
  cancelReason: string | null;
  invitees: Invitee[];
  canEdit: boolean;
  live: boolean;
  myResponse: string | null;
  isOrganizer: boolean;
  unsentInvitations: number;
  googleCalendarUrl: string | null;
}

/** GET /meetings/calendar — the CalendarEvent shape plus what a chip opens. */
interface CalendarRow {
  id: string;
  number: string;
  date: string;
  sortAt: number;
  time: string;
  label: string;
  detail: string;
  done: boolean;
  status: string;
  startsAt: string;
  endsAt: string;
  link: string;
  meetLink: string | null;
  mine: boolean;
}

interface LookupRow {
  id: string;
  name: string;
  email: string;
  position: string | null;
  department: { id: string; name: string } | null;
}

/** Local wall-clock value for a datetime-local input. */
function toLocalInput(d: Date): string {
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
}

/** "Sep 28, 2026, 09:00 AM – 10:00 AM", or both dates when it crosses midnight. */
function whenText(startsAt: string, endsAt: string): string {
  const s = new Date(startsAt);
  const e = new Date(endsAt);
  const time = (d: Date) => d.toLocaleTimeString('en-PH', { hour: '2-digit', minute: '2-digit' });
  if (s.toDateString() === e.toDateString()) {
    return `${formatDate(s)}, ${time(s)} – ${time(e)}`;
  }
  return `${formatDateTime(s)} – ${formatDateTime(e)}`;
}

/** Minutes between two ISO stamps, as people say them. */
function durationText(startsAt: string, endsAt: string): string {
  const minutes = Math.round((new Date(endsAt).getTime() - new Date(startsAt).getTime()) / 60000);
  if (minutes < 60) return `${minutes} min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m ? `${h} h ${m} min` : `${h} h`;
}

function usePeople(): Person[] {
  const [people, setPeople] = useState<Person[]>([]);
  useEffect(() => {
    api
      .get<LookupRow[]>('/users/lookup')
      .then((rows) =>
        setPeople(
          rows.map((r) => ({
            id: r.id,
            name: r.name,
            sub: r.position ?? r.email,
            group: r.department?.name ?? undefined,
          })),
        ),
      )
      .catch(() => setPeople([]));
  }, []);
  return people;
}

// ════════════════════════════════════════════════════════════════════
//  LIST
// ════════════════════════════════════════════════════════════════════

export function Meetings() {
  const { can } = useAuth();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  /** true = a new meeting at the default time; a Date = booked from a day on the grid. */
  const [creating, setCreating] = useState<Date | boolean>(false);
  const [reload, setReload] = useState(0);
  /** `?new=1&job=<id>`: a project's Meetings & Records tab booking a meeting for it. */
  const [presetJobId, setPresetJobId] = useState<string | undefined>(undefined);

  // Read once, then dropped from the URL so a reload does not reopen the form.
  useEffect(() => {
    if (params.get('new') !== '1') return;
    setPresetJobId(params.get('job') ?? undefined);
    setCreating(true);
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.delete('new');
        next.delete('job');
        return next;
      },
      { replace: true },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Which view is open lives in the URL like the list's own filters, so a
  // reload or a shared link lands on the month that was being looked at.
  const month = params.get('show') === 'month';
  function showMonth(on: boolean) {
    setParams((prev) => {
      const next = new URLSearchParams(prev);
      if (on) {
        next.set('show', 'month');
      } else {
        // The calendar's own keys go with it; the list's filters stay, so
        // coming back to the list finds it as it was left.
        for (const key of ['show', 'view', 'month', 'week', 'date']) next.delete(key);
      }
      return next;
    });
  }

  const columns: Column<MeetingRow>[] = [
    {
      key: 'when',
      label: 'When',
      sortKey: 'startsAt',
      width: '220px',
      render: (r) => (
        <div>
          <div>{whenText(r.startsAt, r.endsAt)}</div>
          <div className="faint">{durationText(r.startsAt, r.endsAt)}</div>
        </div>
      ),
    },
    {
      key: 'title',
      label: 'Meeting',
      sortKey: 'title',
      render: (r) => (
        <div>
          <div>{r.title}</div>
          <div className="faint">
            <span className="mono">{r.number}</span>
            {r.location ? ` · ${r.location}` : r.meetLink ? ' · Google Meet' : ''}
          </div>
        </div>
      ),
    },
    {
      key: 'organizer',
      label: 'Organiser',
      render: (r) => (r.isOrganizer ? <span>You</span> : r.organizer.name),
    },
    {
      key: 'invitees',
      label: 'Invited',
      align: 'right',
      render: (r) => (
        <span className="mono">
          {r.acceptedCount}/{r.inviteeCount}
          {!r.sent && r.inviteeCount > 0 && <span className="faint"> unsent</span>}
        </span>
      ),
    },
    {
      key: 'myResponse',
      label: 'My answer',
      render: (r) =>
        r.myResponse ? (
          <StatusBadge status={r.myResponse} extra={RESPONSE_TONES} label={RESPONSE_LABEL[r.myResponse]} />
        ) : (
          <span className="faint">—</span>
        ),
    },
    {
      key: 'status',
      label: 'Status',
      sortKey: 'status',
      render: (r) => <StatusBadge status={r.status} extra={MEETING_TONES} />,
    },
  ];

  const newButton = can('ghr.meetings.create') ? (
    <button type="button" className="btn btn-primary btn-sm" onClick={() => setCreating(true)}>
      + New meeting
    </button>
  ) : null;

  return (
    <div>
      <div className="page-head">
        <h1>Meetings</h1>
        <div className="meetings-head-actions">
          <div className="scope-switch" role="group" aria-label="How to show meetings">
            <button
              type="button"
              className={month ? '' : 'active'}
              aria-pressed={!month}
              onClick={() => showMonth(false)}
            >
              List
            </button>
            <button
              type="button"
              className={month ? 'active' : ''}
              aria-pressed={month}
              onClick={() => showMonth(true)}
            >
              Month
            </button>
          </div>
          {month && newButton}
        </div>
      </div>

      {month ? (
        <MeetingsMonth
          reloadToken={reload}
          onDayClick={can('ghr.meetings.create') ? (day) => setCreating(atNine(day)) : undefined}
        />
      ) : (
        <DataList<MeetingRow>
          listKey="hr-meetings"
          endpoint="/meetings"
          columns={columns}
          rowKey={(r) => r.id}
          scoped
          reloadToken={reload}
          initialFilters={{ when: 'upcoming' }}
          searchPlaceholder="Search title, number, place, organiser…"
          emptyTitle="Nothing scheduled"
          emptyHint="Meetings you organise or are invited to appear here."
          emptyAction={newButton}
          onRowClick={(r) => navigate(`/g-hr/meetings/${r.id}`)}
          filters={[
            {
              key: 'when',
              label: 'When',
              options: [
                { value: 'upcoming', label: 'Upcoming' },
                { value: 'today', label: 'Today' },
                { value: 'past', label: 'Past' },
              ],
            },
            {
              key: 'status',
              label: 'Status',
              options: [
                { value: 'PLANNED', label: 'Planned' },
                { value: 'CANCELLED', label: 'Cancelled' },
              ],
            },
            {
              key: 'role',
              label: 'My part',
              options: [
                { value: 'organizer', label: 'I organise' },
                { value: 'invited', label: 'I am invited' },
              ],
            },
          ]}
          actions={newButton}
        />
      )}

      {creating !== false && (
        <MeetingModal
          startAt={creating instanceof Date ? creating : undefined}
          presetJobId={presetJobId}
          onClose={() => setCreating(false)}
          onSaved={(id) => {
            setCreating(false);
            setReload((n) => n + 1);
            navigate(`/g-hr/meetings/${id}`);
          }}
        />
      )}
    </div>
  );
}

/** Nine in the morning of a local day key — where a meeting booked from the grid starts. */
function atNine(day: string): Date {
  const d = parseDay(day);
  d.setHours(9, 0, 0, 0);
  return d;
}

/**
 * The month grid over the same meetings the list shows — the ones the viewer
 * organises or is invited to, or all of them under view_all. It is the shared
 * MonthCalendar, not a second grid: chips carry their time and title, and a
 * cancelled one says so in words, so the month reads without colour.
 */
function MeetingsMonth({
  reloadToken,
  onDayClick,
}: {
  reloadToken: number;
  onDayClick?: (day: string) => void;
}) {
  const navigate = useNavigate();
  const nav = useCalendarNav({ defaultView: 'month', views: ['month'] });
  const [rows, setRows] = useState<CalendarRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const { from, to, windowKey } = nav;

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api
      .get<CalendarRow[]>(`/meetings/calendar${qs({ from: from.toISOString(), to: to.toISOString() })}`)
      .then((r) => {
        if (cancelled) return;
        setRows(r);
        setError(null);
      })
      .catch((err) => {
        if (!cancelled) setError(err);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // from/to are memoised on windowKey; the key is what names the window.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [windowKey, reloadToken]);

  const events = useMemo<CalendarEvent[]>(
    () =>
      rows.map((r) => ({
        id: r.id,
        // The grid buckets on the viewer's LOCAL day (MonthCalendar's
        // contract); the server's Manila key is the same day for everyone in
        // the company's time zone and only a fallback here.
        date: dayKeyOf(new Date(r.startsAt)) || r.date,
        sortAt: r.sortAt,
        time: r.time,
        label: r.status === 'CANCELLED' ? `${r.label} (cancelled)` : r.label,
        detail: [r.number, r.detail].filter(Boolean).join(' · '),
        tone: statusTone(r.status, MEETING_TONES),
        done: r.done,
      })),
    [rows],
  );

  return (
    <div className="meetings-month">
      <CalendarToolbar nav={nav} />
      <ErrorBox error={error} />
      <MonthCalendar
        nav={nav}
        events={events}
        loading={loading}
        itemNoun={{ one: 'meeting', many: 'meetings' }}
        emptyNote={`No meetings in ${nav.label} that you organise or are invited to.`}
        onDayClick={onDayClick}
        onEventClick={(e) => navigate(`/g-hr/meetings/${e.id}`)}
      />
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════
//  CREATE / EDIT
// ════════════════════════════════════════════════════════════════════

function MeetingModal({
  initial,
  startAt,
  presetJobId,
  onClose,
  onSaved,
}: {
  initial?: Meeting;
  /** A new meeting booked from a day on the month grid starts there. */
  startAt?: Date;
  /** A new meeting booked from a project's Meetings & Records tab is for it. */
  presetJobId?: string;
  onClose: () => void;
  onSaved: (id: string) => void;
}) {
  const { me, can } = useAuth();
  const toast = useToast();
  const people = usePeople();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [jobId, setJobId] = useState(initial?.job?.id ?? presetJobId ?? '');
  // The project picker needs the projects right; without it the preset (or
  // the project already on the meeting) is kept and shown, never dropped.
  const seesProjects = can('gops.projects.view_all') || can('gops.projects.view_own');
  const [jobs, setJobs] = useState<{ id: string; number: string; name: string }[]>([]);
  useEffect(() => {
    if (!seesProjects) return;
    api
      .get<{ id: string; number: string; name: string }[]>('/jobs/lookup?includeClosed=true')
      .then(setJobs)
      .catch(() => {});
  }, [seesProjects]);
  const knownJob = initial?.job && initial.job.id === jobId ? initial.job : jobs.find((j) => j.id === jobId);

  const defaultStart = useMemo(() => {
    if (startAt) return startAt;
    const d = new Date();
    d.setDate(d.getDate() + 1);
    d.setHours(9, 0, 0, 0);
    return d;
  }, [startAt]);

  const [form, setForm] = useState({
    title: initial?.title ?? '',
    location: initial?.location ?? '',
    agenda: initial?.agenda ?? '',
    startsAt: toLocalInput(initial ? new Date(initial.startsAt) : defaultStart),
    endsAt: toLocalInput(initial ? new Date(initial.endsAt) : new Date(defaultStart.getTime() + 3_600_000)),
  });
  const [inviteeIds, setInviteeIds] = useState<string[]>([]);

  const editing = Boolean(initial);
  const valid =
    form.title.trim().length >= 3 &&
    form.startsAt &&
    form.endsAt &&
    new Date(form.endsAt).getTime() > new Date(form.startsAt).getTime();

  /** Moving the start keeps the length — the usual thing somebody means. */
  function setStart(value: string) {
    const oldStart = new Date(form.startsAt).getTime();
    const oldEnd = new Date(form.endsAt).getTime();
    const next = new Date(value);
    if (Number.isNaN(next.getTime()) || Number.isNaN(oldStart) || Number.isNaN(oldEnd)) {
      setForm({ ...form, startsAt: value });
      return;
    }
    const length = Math.max(oldEnd - oldStart, 15 * 60_000);
    setForm({ ...form, startsAt: value, endsAt: toLocalInput(new Date(next.getTime() + length)) });
  }

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const payload = {
        title: form.title.trim(),
        location: form.location.trim() || null,
        agenda: form.agenda.trim() || null,
        startsAt: new Date(form.startsAt).toISOString(),
        endsAt: new Date(form.endsAt).toISOString(),
        jobId: jobId || null,
      };
      if (initial) {
        await api.patch(`/meetings/${initial.id}`, payload);
        toast('ok', 'Meeting updated');
        onSaved(initial.id);
      } else {
        const created = await api.post<{ id: string }>('/meetings', { ...payload, inviteeIds });
        toast('ok', 'Meeting scheduled — send the invitations when the list is right');
        onSaved(created.id);
      }
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  }

  return (
    <Modal
      title={initial ? `Modify meeting ${initial.number}` : 'New meeting'}
      onClose={onClose}
      wide
      footer={
        <ModalFoot onCancel={onClose} busy={busy}>
          <button type="button" className="btn btn-primary" onClick={save} disabled={busy || !valid}>
            {busy ? 'Saving…' : 'Save'}
          </button>
        </ModalFoot>
      }
    >
      <ErrorBox error={error} />

      <Field label="Title" required>
        <input
          value={form.title}
          onChange={(e) => setForm({ ...form, title: e.target.value })}
          placeholder="Weekly operations, project kick-off…"
        />
      </Field>

      <div className="grid grid-2">
        <Field label="Starts" required>
          <input type="datetime-local" value={form.startsAt} onChange={(e) => setStart(e.target.value)} />
        </Field>
        <Field
          label="Ends"
          required
          error={
            form.startsAt && form.endsAt && new Date(form.endsAt) <= new Date(form.startsAt)
              ? 'It ends before it starts'
              : null
          }
        >
          <input
            type="datetime-local"
            value={form.endsAt}
            onChange={(e) => setForm({ ...form, endsAt: e.target.value })}
          />
        </Field>
      </div>

      {seesProjects ? (
        <Field label="For project" hint="A kick-off, a site meeting, a turnover — it then shows on that project's Meetings & Records tab.">
          <select value={jobId} onChange={(e) => setJobId(e.target.value)}>
            <option value="">— none —</option>
            {jobId && !jobs.some((j) => j.id === jobId) && knownJob && (
              <option value={jobId}>
                {knownJob.number} — {knownJob.name}
              </option>
            )}
            {jobs.map((j) => (
              <option key={j.id} value={j.id}>
                {j.number} — {j.name}
              </option>
            ))}
          </select>
        </Field>
      ) : (
        knownJob && (
          <p className="muted">
            For project {knownJob.number} — {knownJob.name}
          </p>
        )
      )}

      <Field label="Where" hint="A room, a site, or leave it blank for an online meeting.">
        <input
          value={form.location}
          onChange={(e) => setForm({ ...form, location: e.target.value })}
          placeholder="Board room"
        />
      </Field>

      <Field label="Agenda">
        <textarea
          rows={4}
          value={form.agenda}
          onChange={(e) => setForm({ ...form, agenda: e.target.value })}
          placeholder="What is to be covered — this goes into the calendar invitation."
        />
      </Field>

      {!editing && (
        <Field
          label="Invite"
          hint="People with a G-CORE login. Nobody is told until you press Send invitations."
        >
          <PeoplePicker
            people={people}
            value={inviteeIds}
            onChange={setInviteeIds}
            exclude={me ? [me.user.id] : []}
          />
        </Field>
      )}
      {editing && (
        <p className="muted">
          Moving the time tells everyone who has already been invited. Add or remove people from
          the meeting page.
        </p>
      )}
    </Modal>
  );
}

// ════════════════════════════════════════════════════════════════════
//  DETAIL
// ════════════════════════════════════════════════════════════════════

export function MeetingDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { can } = useAuth();
  const toast = useToast();
  const confirm = useConfirm();

  const [meeting, setMeeting] = useState<Meeting | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [editing, setEditing] = useState(false);
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!id) return;
    try {
      setMeeting(await api.get<Meeting>(`/meetings/${id}`));
      setError(null);
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  async function run(key: string, fn: () => Promise<void>) {
    setBusy(key);
    setError(null);
    try {
      await fn();
      await load();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(null);
    }
  }

  if (loading) return <Loading />;
  if (!meeting) return <ErrorBox error={error ?? new Error('Meeting not found')} />;

  const m = meeting;
  const planned = m.status === 'PLANNED';
  const sent = m.invitees.some((i) => i.notifiedAt);
  const canDelete = !sent && (m.canEdit || can('ghr.meetings.delete'));
  const accepted = m.invitees.filter((i) => i.response === 'ACCEPTED').length;

  async function send() {
    await run('send', async () => {
      const r = await api.post<{ sent: number }>(`/meetings/${m.id}/send`);
      toast('ok', r.sent ? `Invitations sent to ${r.sent}` : 'Everyone has already been invited');
    });
  }

  async function respond(response: 'ACCEPTED' | 'TENTATIVE' | 'DECLINED') {
    await run(`respond:${response}`, async () => {
      await api.post(`/meetings/${m.id}/respond`, { response });
      toast('ok', `Answered: ${RESPONSE_LABEL[response].toLowerCase()}`);
    });
  }

  /** Asked through the confirm bar, which shows a refusal and stays open. */
  async function removeInvitee(userId: string) {
    await api.del(`/meetings/${m.id}/invitees/${userId}`);
    await load();
  }

  /** Asked through the confirm bar, which shows a refusal and stays open. */
  async function remove() {
    await api.del(`/meetings/${m.id}`);
    toast('ok', 'Meeting deleted');
    navigate('/g-hr/meetings');
  }

  const told = m.invitees.filter((i) => i.notifiedAt).length;

  /** Asked through the confirm bar, with the reason everyone invited is told. */
  async function cancel(reason: string) {
    await api.post(`/meetings/${m.id}/cancel`, { reason });
    toast('ok', told ? `Cancelled — ${told} told` : 'Cancelled');
    await load();
  }

  const sending = m.canEdit && planned && m.unsentInvitations > 0;

  async function saveLink(googleUrl: string) {
    await api.patch(`/meetings/${m.id}`, { googleUrl });
    await load();
  }

  return (
    <div className="meeting-page">
      <RecordHeader
        type="Meeting"
        code={m.number}
        title={m.title}
        status={m.status}
        statusExtra={MEETING_TONES}
        meta={
          <>
            <strong>{whenText(m.startsAt, m.endsAt)}</strong> · {durationText(m.startsAt, m.endsAt)} · organised
            by {m.isOrganizer ? 'you' : m.organizer.name}
            {m.location ? ` · ${m.location}` : ''}
            {m.job && (
              <>
                {' '}
                · for <Link to={`/g-ops/projects/${m.job.id}?tab=meetings`}>{m.job.number}</Link> {m.job.name}
              </>
            )}
          </>
        }
        actions={
          <>
            {m.live && m.meetLink && (
              <a
                className={`btn${sending ? '' : ' btn-primary'}`}
                href={m.meetLink}
                target="_blank"
                rel="noopener noreferrer"
              >
                Join now
              </a>
            )}
            {sending && (
              <button type="button" className="btn btn-primary" onClick={send} disabled={busy === 'send'}>
                {busy === 'send' ? 'Sending…' : `Send invitations (${m.unsentInvitations})`}
              </button>
            )}
            <button
              type="button"
              className="btn"
              disabled={busy === 'ics'}
              onClick={() =>
                run('ics', async () => {
                  await downloadBlob(`/meetings/${m.id}/ics`, `${m.number}.ics`);
                })
              }
            >
              Add to calendar (.ics)
            </button>
          </>
        }
        more={[
          m.canEdit &&
            planned && {
              label: 'Cancel meeting',
              danger: true,
              confirm: {
                title: `Cancel ${m.number}?`,
                body: told
                  ? `${told} ${told === 1 ? 'person has' : 'people have'} been invited and will be told, with your reason.`
                  : 'Nobody has been invited yet, so nobody needs telling — the record stays as cancelled.',
                confirmLabel: 'Cancel meeting',
                reason: 'required',
                reasonLabel: 'Why',
                // The API wants three characters; the bar waits for them.
                minReason: 3,
                onConfirm: (reason) => cancel(reason),
              },
            },
          canDelete &&
            planned && {
              label: 'Delete',
              danger: true,
              confirm: {
                title: `Delete ${m.number}?`,
                body: 'Nobody has been invited yet, so nothing needs telling. It cannot be undone.',
                confirmLabel: 'Delete',
                onConfirm: remove,
              },
            },
        ]}
        modify={m.canEdit && planned ? () => setEditing(true) : undefined}
        confirm={confirm}
      />

      <ErrorBox error={error} />

      {m.status === 'CANCELLED' && (
        <div className="alert warn">
          Cancelled{m.cancelReason ? ` — ${m.cancelReason}` : ''}. Everyone who was invited has been told;
          a re-downloaded calendar file withdraws the event.
        </div>
      )}
      {m.canEdit && planned && m.unsentInvitations > 0 && (
        <div className="alert info">
          {m.unsentInvitations === m.invitees.length
            ? 'Nobody has been invited yet.'
            : `${m.unsentInvitations} of the people listed have not been invited yet.`}{' '}
          Press <strong>Send invitations</strong> when the list is right.
        </div>
      )}

      {m.myResponse && planned && (
        <div className="card meeting-respond">
          <div className="row meeting-split">
            <div>
              <h3 className="card-title meeting-flush">Will you be there?</h3>
              <div className="faint">
                {m.myResponse === 'PENDING' ? 'You have not answered yet.' : `You answered: ${RESPONSE_LABEL[m.myResponse].toLowerCase()}.`}
              </div>
            </div>
            <div className="row respond-group" role="group" aria-label="Your answer">
              {(['ACCEPTED', 'TENTATIVE', 'DECLINED'] as const).map((r) => (
                <button
                  key={r}
                  type="button"
                  className={`btn btn-sm${m.myResponse === r ? ' btn-active' : ''}`}
                  aria-pressed={m.myResponse === r}
                  disabled={busy !== null}
                  onClick={() => respond(r)}
                >
                  {r === 'ACCEPTED' ? 'Yes' : r === 'TENTATIVE' ? 'Maybe' : 'No'}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      <div className="grid grid-2 meeting-body">
        <div className="stack">
          <div className="card">
            <h3 className="card-title">Google Meet</h3>
            <MeetLink
              meetLink={m.meetLink}
              calendarEventUrl={m.calendarEventUrl}
              googleCalendarUrl={m.googleCalendarUrl}
              canEdit={m.canEdit && planned}
              onSave={saveLink}
              live={m.live}
            />
          </div>

          <div className="card">
            <h3 className="card-title">Agenda</h3>
            {m.agenda ? (
              <p className="meeting-agenda">{m.agenda}</p>
            ) : (
              <p className="collection-empty">No agenda written.</p>
            )}
          </div>
        </div>

        <div className="card">
          <div className="row meeting-split meeting-card-head">
            <h3 className="card-title meeting-flush">
              People{' '}
              <span className="faint">
                {accepted}/{m.invitees.length} accepted
              </span>
            </h3>
            {m.canEdit && planned && (
              <button type="button" className="btn btn-sm" onClick={() => setAdding(true)}>
                + Add people
              </button>
            )}
          </div>

          {m.invitees.length === 0 ? (
            <Empty
              title="Nobody invited yet"
              hint="Add the people who should be there. They are told when you send the invitations."
              action={
                m.canEdit && planned ? (
                  <button type="button" className="btn btn-primary btn-sm" onClick={() => setAdding(true)}>
                    + Add people
                  </button>
                ) : null
              }
            />
          ) : (
            <div className="table-wrap">
              <table className="data meeting-invitees">
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Attendance</th>
                    <th>Answer</th>
                    <th>Invited</th>
                    {m.canEdit && planned && <th className="meeting-col-actions" />}
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td>
                      <div>{m.organizer.name}</div>
                      <div className="faint">{m.organizer.position ?? m.organizer.email}</div>
                    </td>
                    <td>Organiser</td>
                    <td>
                      <span className="faint">—</span>
                    </td>
                    <td>
                      <span className="faint">—</span>
                    </td>
                    {m.canEdit && planned && <td />}
                  </tr>
                  {m.invitees.map((i) => (
                    <tr key={i.id}>
                      <td>
                        <div>{i.user.name}</div>
                        <div className="faint">{i.user.position ?? i.user.email}</div>
                      </td>
                      <td>{i.required ? 'Required' : <span className="faint">Optional</span>}</td>
                      <td>
                        <StatusBadge status={i.response} extra={RESPONSE_TONES} label={RESPONSE_LABEL[i.response]} />
                        {i.respondedAt && <div className="faint">{formatDateTime(i.respondedAt)}</div>}
                      </td>
                      <td>
                        {i.notifiedAt ? (
                          <span title={formatDateTime(i.notifiedAt)}>{formatDate(i.notifiedAt)}</span>
                        ) : (
                          <span className="faint">not yet</span>
                        )}
                      </td>
                      {m.canEdit && planned && (
                        <td>
                          <button
                            type="button"
                            className="btn btn-sm"
                            aria-label={`Remove ${i.user.name}`}
                            onClick={() =>
                              confirm.ask({
                                title: `Remove ${i.user.name} from ${m.number}?`,
                                body: i.notifiedAt
                                  ? 'They were invited, and are told the invitation is withdrawn.'
                                  : 'They have not been invited yet, so nobody is told.',
                                confirmLabel: 'Remove',
                                onConfirm: () => removeInvitee(i.userId),
                              })
                            }
                          >
                            Remove
                          </button>
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      <div className="meeting-attachments">
        <Attachments
          entityType="meeting"
          entityId={m.id}
          title="Documents"
          hint="Pre-reads, minutes, presentations — whatever the meeting needs, kept with it."
          canEdit={m.canEdit || m.myResponse !== null}
        />
      </div>

      {editing && (
        <MeetingModal
          initial={m}
          onClose={() => setEditing(false)}
          onSaved={() => {
            setEditing(false);
            void load();
          }}
        />
      )}

      {adding && (
        <AddPeopleModal
          meeting={m}
          onClose={() => setAdding(false)}
          onAdded={() => {
            setAdding(false);
            void load();
          }}
        />
      )}
    </div>
  );
}

function AddPeopleModal({
  meeting,
  onClose,
  onAdded,
}: {
  meeting: Meeting;
  onClose: () => void;
  onAdded: () => void;
}) {
  const toast = useToast();
  const people = usePeople();
  const [ids, setIds] = useState<string[]>([]);
  const [required, setRequired] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const exclude = useMemo(
    () => [meeting.organizerId, ...meeting.invitees.map((i) => i.userId)],
    [meeting],
  );

  async function add() {
    setBusy(true);
    setError(null);
    try {
      await api.post(`/meetings/${meeting.id}/invitees`, { userIds: ids, required });
      toast('ok', `${ids.length} added — send the invitations when you are ready`);
      onAdded();
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  }

  return (
    <Modal
      title="Add people"
      onClose={onClose}
      footer={
        <ModalFoot onCancel={onClose} busy={busy}>
          <button type="button" className="btn btn-primary" onClick={add} disabled={busy || ids.length === 0}>
            {busy ? 'Adding…' : `Add ${ids.length || ''}`.trim()}
          </button>
        </ModalFoot>
      }
    >
      <ErrorBox error={error} />
      <PeoplePicker people={people} value={ids} onChange={setIds} exclude={exclude} />
      <div className="meeting-required">
        <Checkbox checked={required} onChange={setRequired} label="Their attendance is required" />
      </div>
    </Modal>
  );
}
