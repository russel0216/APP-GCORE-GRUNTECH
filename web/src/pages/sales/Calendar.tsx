import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { api, qs } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { dayKeyOf, parseDay, todayLocal, weekDays } from '../../lib/day';
import { Checkbox, ErrorBox, Field, Modal, StatusBadge, formatDateTime, statusTone, useToast } from '../../components/ui';
import { KIND_LABEL } from '../service/Reports';
import {
  CalendarToolbar,
  MonthCalendar,
  useCalendarNav,
  type CalendarEvent,
} from '../../components/MonthCalendar';
import { PeoplePicker } from '../../components/PeoplePicker';

// ════════════════════════════════════════════════════════════════════
//  SALES CALENDAR
// ════════════════════════════════════════════════════════════════════

const ACTIVITY_TYPES = [
  { value: 'SITE_VISIT', label: 'Site visit' },
  { value: 'MEETING', label: 'Meeting' },
  { value: 'CALL', label: 'Call' },
  { value: 'FOLLOW_UP', label: 'Follow-up' },
  { value: 'SUBMISSION', label: 'Submission' },
  { value: 'OTHER', label: 'Other' },
];

/** Planned is the default chip; done reads as settled. Cancelled falls to statusTone's danger. */
const ACTIVITY_TONES = { PLANNED: '', DONE: 'ok' } as const;

/** An invitee's answer (InviteeResponse): PENDING is "No reply". */
type Rsvp = 'PENDING' | 'ACCEPTED' | 'TENTATIVE' | 'DECLINED';
const RSVP_LABEL: Record<Rsvp, string> = { ACCEPTED: 'Going', TENTATIVE: 'Maybe', DECLINED: 'Not going', PENDING: 'No reply' };
/** The marks a chip carries — readable without colour, and without the words. */
const RSVP_MARK: Record<Rsvp, string> = { ACCEPTED: '✓', TENTATIVE: '~', DECLINED: '✗', PENDING: '?' };
const ANSWERS: Rsvp[] = ['ACCEPTED', 'TENTATIVE', 'DECLINED'];

interface Activity {
  id: string;
  type: string;
  status: string;
  subject: string;
  notes: string | null;
  location: string | null;
  startsAt: string;
  /** Derived by the API: startsAt + durationMinutes. */
  endsAt: string;
  durationMinutes: number;
  reminderMinutes: number | null;
  assignedTo: { id: string; name: string };
  invitees: { userId: string; response: Rsvp; respondedAt: string | null; user: { id: string; name: string } }[];
  /** The API's tally of the invitees' answers. */
  responses?: { going: number; maybe: number; notGoing: number; noReply: number };
  lead: { id: string; number: string; companyName: string } | null;
  quotation: { id: string; number: string } | null;
  customer: { id: string; name: string } | null;
}

interface Person {
  id: string;
  name: string;
}

/** "✓2 ✗1 ?3" (and "~1" only when somebody said maybe), or null with nobody invited. */
function tallyText(a: Activity): string | null {
  if (!a.invitees.length) return null;
  const n = (r: Rsvp) => a.invitees.filter((i) => i.response === r).length;
  const parts = [`✓${n('ACCEPTED')}`, `✗${n('DECLINED')}`, `?${n('PENDING')}`];
  if (n('TENTATIVE')) parts.splice(1, 0, `~${n('TENTATIVE')}`);
  return parts.join(' ');
}

function toEvent(a: Activity): CalendarEvent {
  const at = new Date(a.startsAt);
  const tally = tallyText(a);
  return {
    id: a.id,
    date: dayKeyOf(at),
    sortAt: at.getTime(),
    time: at.toLocaleTimeString('en-PH', { hour: '2-digit', minute: '2-digit' }),
    label: a.subject,
    detail: `${a.assignedTo.name}${tally ? ` · ${tally}` : ''}${
      a.lead ? ` · ${a.lead.companyName}` : a.customer ? ` · ${a.customer.name}` : ''
    }`,
    tone: statusTone(a.status, ACTIVITY_TONES),
    done: a.status !== 'PLANNED',
  };
}

/** The slice of a service visit the sales calendar shows. */
interface ServiceVisitChip {
  id: string;
  kind: string;
  status: string;
  dueDate: string;
  customer: { id: string; name: string };
  site: { id: string; name: string } | null;
  asset: { id: string; code: string; name: string } | null;
  assignedTo: { id: string; name: string } | null;
}

/** Visit chips share the grid with activities; the prefix keeps their ids apart. */
const VISIT_PREFIX = 'visit:';

/*
  A service visit is context here, not sales work: somebody selling to a
  customer wants to know an engineer is on their site on Thursday, but it is
  not theirs to book or move. So the series is quiet — no tone, dimmed — and
  every chip says "Service" in words, so it reads without colour, and opens
  the visit on the Service Schedule rather than the activity form.
*/
function visitToEvent(v: ServiceVisitChip): CalendarEvent {
  return {
    id: `${VISIT_PREFIX}${v.id}`,
    // A visit is due on a day, not at a time: all-day, sorts first.
    date: v.dueDate.slice(0, 10),
    time: null,
    label: `Service · ${v.customer.name}`,
    detail: `${KIND_LABEL[v.kind] ?? v.kind} · ${v.asset?.name ?? v.site?.name ?? 'site'} · ${
      v.assignedTo?.name ?? 'unassigned'
    }`,
    tone: '',
    done: true,
  };
}

/** The reminder offsets the API accepts (REMINDER_MINUTES in shared/activities.ts). */
const REMINDERS = [
  { value: '', label: 'No reminder' },
  { value: '15', label: '15 minutes before' },
  { value: '60', label: '1 hour before' },
  { value: '120', label: '2 hours before' },
  { value: '1440', label: '1 day before' },
];

/** Local wall-clock value for a datetime-local input. */
function toLocalInput(d: Date): string {
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
}

/**
 * "One look at what all the sales personnel are going to do by day."
 *
 * Week is the zoom, month is the overview. The week grid — a column per day —
 * is where the question "what is anyone doing on Thursday" gets answered, so
 * it stays the default. The month grid shows the shape of the weeks ahead
 * and, clicking a day, zooms into that week. Which one is open, and where,
 * lives in the URL, so a reload and a shared link both land where you were.
 */
export function SalesCalendar() {
  const toast = useToast();
  const { can, me } = useAuth();
  const navigate = useNavigate();
  const nav = useCalendarNav({ defaultView: 'week' });
  const [params, setParams] = useSearchParams();
  const [activities, setActivities] = useState<Activity[]>([]);
  const [visits, setVisits] = useState<ServiceVisitChip[]>([]);
  // On by default for anyone who may see the schedule; `?visits=0` hides it,
  // in the URL like the view, so a shared link shows what its sender saw.
  const canVisits = can('gops.visits.view_all');
  const showVisits = canVisits && params.get('visits') !== '0';
  const [people, setPeople] = useState<Person[]>([]);
  const [who, setWho] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [editing, setEditing] = useState<Activity | 'new' | null>(null);
  /** The activity's detailed view (2026-10-08): clicking a chip opens this, never the form. */
  const [viewing, setViewing] = useState<Activity | null>(null);
  const [tick, setTick] = useState(0);

  const { from, to, windowKey } = nav;

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api
      .get<Activity[]>(`/activities${qs({ from: from.toISOString(), to: to.toISOString(), assignedToId: who })}`)
      .then((rows) => {
        if (cancelled) return;
        setActivities(rows);
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
  }, [windowKey, who, tick]);

  /*
    The service series. Not filtered by "whose activities": that picker lists
    the people booked on THIS calendar, and visits belong to engineers, so
    filtering by a salesperson would only ever empty it. Reports with no
    visit are history rather than schedule, and stay on the Service Schedule.
  */
  useEffect(() => {
    if (!showVisits) {
      setVisits([]);
      return;
    }
    let cancelled = false;
    api
      .get<{ visits: ServiceVisitChip[] }>(
        `/service-visits/calendar${qs({ from: dayKeyOf(from), to: dayKeyOf(to), includeReports: 'false' })}`,
      )
      .then((feed) => {
        if (!cancelled) setVisits(feed.visits);
      })
      // The activities are the page; a schedule that will not load leaves them standing.
      .catch(() => {
        if (!cancelled) setVisits([]);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [windowKey, showVisits]);

  function toggleVisits(on: boolean) {
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        if (on) next.delete('visits');
        else next.set('visits', '0');
        return next;
      },
      { replace: true },
    );
  }

  function openEvent(id: string) {
    if (id.startsWith(VISIT_PREFIX)) {
      navigate(`/g-ops/visits${qs({ visit: id.slice(VISIT_PREFIX.length) })}`);
      return;
    }
    const a = byId.get(id);
    if (a) setViewing(a);
  }

  /** After an answer, Mark done or Cancel: the window reloads and the open view reads the activity again. */
  async function refreshViewing(id: string) {
    setTick((t) => t + 1);
    try {
      setViewing(await api.get<Activity>(`/activities/${encodeURIComponent(id)}`));
    } catch {
      setViewing(null);
    }
  }

  useEffect(() => {
    api
      // Only people who can open this calendar can be booked on it.
      .get<Person[]>(`/users/lookup${qs({ holding: 'gops.calendar.view_all' })}`)
      .then((rows) => setPeople(rows.map((p) => ({ id: p.id, name: p.name }))))
      .catch(() => {});
  }, []);

  /*
    A notification links to `?activity=<id>&date=<day>`. The `date` already
    put the calendar on the right week (useCalendarNav resolves it before the
    first fetch); this opens the activity itself. It is read once, straight
    from GET /activities/:id rather than out of the loaded window, so a link
    whose date is stale — the activity was moved since — still finds it, and
    then moves the calendar to where it now is. A link to a deleted activity
    says so instead of opening nothing.
  */
  const linked = useRef<string | null>(params.get('activity'));
  // `?respond=ACCEPTED|TENTATIVE|DECLINED` comes from the invitation email's
  // links (2026-10-08): the answer is recorded on opening, for an invitee of
  // a planned activity only, and the key drops out of the URL.
  const linkedAnswer = useRef<Rsvp | null>(
    (ANSWERS as string[]).includes(params.get('respond') ?? '') ? (params.get('respond') as Rsvp) : null,
  );
  useEffect(() => {
    // Not consumed here: StrictMode runs this twice and cancels the first,
    // so clearing the ref would leave the second run with nothing to open.
    const id = linked.current;
    if (!id) return;
    let cancelled = false;
    const answer = linkedAnswer.current;
    api
      .get<Activity>(`/activities/${encodeURIComponent(id)}`)
      .then(async (found) => {
        if (cancelled) return;
        const day = dayKeyOf(new Date(found.startsAt));
        if (nav.view === 'week' && weekDays(nav.week).includes(day)) nav.setFocus(day);
        else nav.goToWeekOf(day);
        let shown = found;
        if (answer && found.status === 'PLANNED' && found.invitees.some((i) => i.userId === me?.user.id)) {
          try {
            shown = await api.post<Activity>(`/activities/${encodeURIComponent(id)}/respond`, { response: answer });
            toast('ok', `Marked as ${RSVP_LABEL[answer].toLowerCase()}`);
            setTick((t) => t + 1);
          } catch {
            toast('error', 'Your answer was not recorded — use the buttons on the activity');
          }
        }
        if (cancelled) return;
        setViewing(shown);
        if (answer) {
          setParams(
            (prev) => {
              const next = new URLSearchParams(prev);
              next.delete('respond');
              return next;
            },
            { replace: true },
          );
        }
      })
      .catch(() => {
        if (!cancelled) toast('error', 'That activity no longer exists');
      });
    return () => {
      cancelled = true;
    };
    // Once, on mount: the id is consumed and the view owns what happens next.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function closeModal() {
    setEditing(null);
    setViewing(null);
    if (params.has('activity') || params.has('respond')) {
      setParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          next.delete('activity');
          next.delete('respond');
          return next;
        },
        { replace: true },
      );
    }
  }

  const events = useMemo(
    () => [...activities.map(toEvent), ...visits.map(visitToEvent)],
    [activities, visits],
  );
  const byId = useMemo(() => new Map(activities.map((a) => [a.id, a])), [activities]);
  const today = todayLocal();
  const days = useMemo(() => weekDays(nav.week), [nav.week]);

  /*
    "+ Schedule" proposes the day the person is looking at. Today keeps the
    old "an hour from now"; any other focused day starts at nine.
  */
  const defaultStart = useMemo(() => {
    if (nav.focus === today) return new Date(Date.now() + 3600000);
    const d = parseDay(nav.focus);
    d.setHours(9, 0, 0, 0);
    return d;
  }, [nav.focus, today]);

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Sales Calendar</h1>
          <p>
            What everyone in sales is doing this week or this month — site visits, follow-ups,
            submissions. Scheduling something for someone else, or inviting them, notifies them;
            a reminder goes to everyone on it.
          </p>
        </div>
        <button type="button" className="btn btn-primary" onClick={() => setEditing('new')}>
          + Schedule
        </button>
      </div>

      <CalendarToolbar nav={nav}>
        <select
          className="cal-person"
          aria-label="Whose activities (booked for them or invited)"
          value={who}
          onChange={(e) => setWho(e.target.value)}
        >
          <option value="">Everyone</option>
          {people.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
        {canVisits && (
          <Checkbox checked={showVisits} onChange={toggleVisits} label="Show service visits" />
        )}
      </CalendarToolbar>

      <ErrorBox error={error} />

      {nav.view === 'month' ? (
        <MonthCalendar
          nav={nav}
          events={events}
          loading={loading}
          itemNoun={{ one: 'activity', many: 'activities' }}
          onDayClick={nav.goToWeekOf}
          onEventClick={(e) => openEvent(e.id)}
        />
      ) : (
        <div className="calendar-week" aria-busy={loading ? 'true' : undefined}>
          {days.map((day) => {
            const items = events.filter((e) => e.date === day);
            const date = parseDay(day);
            const isFocus = day === nav.focus;
            return (
              <div
                key={day}
                className={`cal-day${day === today ? ' today' : ''}${isFocus ? ' focused' : ''}`}
              >
                <button
                  type="button"
                  className="cal-head"
                  aria-pressed={isFocus}
                  aria-label={`${date.toLocaleDateString('en-PH', {
                    weekday: 'long',
                    day: 'numeric',
                    month: 'long',
                  })} — pick this day for scheduling`}
                  onClick={() => nav.setFocus(day)}
                >
                  <span>{date.toLocaleDateString('en-PH', { weekday: 'short' })}</span>
                  <strong>{date.getDate()}</strong>
                </button>
                <div className="cal-body">
                  {items.length === 0 ? (
                    <div className="cal-empty">—</div>
                  ) : (
                    items.map((e) => (
                      <button
                        key={e.id}
                        type="button"
                        className={`cal-item${e.done ? ' done' : ''}${
                          e.id.startsWith(VISIT_PREFIX) ? ' service' : ''
                        }`}
                        onClick={() => openEvent(e.id)}
                      >
                        <span className="mono cal-item-time">{e.time}</span>
                        <span>{e.label}</span>
                        <span className="cal-item-sub">{e.detail}</span>
                      </button>
                    ))
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {viewing && !editing && (
        <ActivityPanel
          activity={viewing}
          meId={me?.user.id ?? ''}
          onClose={closeModal}
          onModify={() => setEditing(viewing)}
          onChanged={() => refreshViewing(viewing.id)}
        />
      )}

      {editing && (
        <ActivityModal
          activity={editing === 'new' ? null : editing}
          people={people}
          defaultStart={defaultStart}
          onClose={() => {
            // Back from Modify to the detailed view; a new activity's form just closes.
            if (editing === 'new' || !viewing) closeModal();
            else setEditing(null);
          }}
          onSaved={() => {
            closeModal();
            setTick((t) => t + 1);
            toast('ok', 'Saved');
          }}
        />
      )}
    </div>
  );
}

/**
 * The activity's detailed view (2026-10-08, SCORO's): what, when, where, who,
 * the records it is linked to, the notes, and the answers as a table grouped
 * Going / Maybe / Not going / No reply with when each was given — so who is
 * coming is read off one screen. An invitee answers here; whoever may edit
 * the calendar modifies (the form), marks it done or cancels it.
 */
function ActivityPanel({
  activity,
  meId,
  onClose,
  onModify,
  onChanged,
}: {
  activity: Activity;
  meId: string;
  onClose: () => void;
  onModify: () => void;
  onChanged: () => Promise<void> | void;
}) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [confirmCancel, setConfirmCancel] = useState(false);

  const mine = activity.invitees.find((i) => i.userId === meId) ?? null;
  const planned = activity.status === 'PLANNED';
  const start = new Date(activity.startsAt);
  const end = new Date(activity.endsAt);
  const when = `${formatDateTime(start)} – ${
    dayKeyOf(start) === dayKeyOf(end) ? end.toLocaleTimeString('en-PH', { hour: '2-digit', minute: '2-digit' }) : formatDateTime(end)
  }`;
  const n = (r: Rsvp) => activity.invitees.filter((i) => i.response === r).length;
  const summary = [
    `${n('ACCEPTED')} going`,
    n('TENTATIVE') ? `${n('TENTATIVE')} maybe` : null,
    `${n('DECLINED')} not going`,
    `${n('PENDING')} no reply`,
  ]
    .filter(Boolean)
    .join(' · ');
  const groups: { key: Rsvp; cls: string }[] = [
    { key: 'ACCEPTED', cls: 'going' },
    { key: 'TENTATIVE', cls: 'maybe' },
    { key: 'DECLINED', cls: 'not-going' },
    { key: 'PENDING', cls: 'no-reply' },
  ];

  async function run(fn: () => Promise<unknown>, done: string) {
    setBusy(true);
    setError(null);
    try {
      await fn();
      toast('ok', done);
      await onChanged();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }
  const respond = (r: Rsvp) =>
    run(() => api.post(`/activities/${activity.id}/respond`, { response: r }), `Marked as ${RSVP_LABEL[r].toLowerCase()}`);
  const markDone = () => run(() => api.patch(`/activities/${activity.id}`, { status: 'DONE' }), 'Marked done');
  const cancel = () => run(() => api.patch(`/activities/${activity.id}`, { status: 'CANCELLED' }), 'Cancelled — everyone on it is told');

  return (
    <Modal
      title={activity.subject}
      onClose={onClose}
      wide
      footer={
        <>
          {planned &&
            (confirmCancel ? (
              <>
                <span>Cancel this activity? Everyone on it is told.</span>
                <button type="button" className="btn btn-danger" onClick={cancel} disabled={busy}>
                  Yes, cancel it
                </button>
                <button type="button" className="btn" onClick={() => setConfirmCancel(false)} disabled={busy}>
                  Keep it
                </button>
              </>
            ) : (
              <button type="button" className="btn btn-danger" onClick={() => setConfirmCancel(true)} disabled={busy}>
                Cancel activity
              </button>
            ))}
          {planned && !confirmCancel && (
            <button type="button" className="btn" onClick={markDone} disabled={busy}>
              Mark done
            </button>
          )}
          <div className="topbar-spacer" />
          <button type="button" className="btn" onClick={onClose} disabled={busy}>
            Close
          </button>
          <button type="button" className="btn btn-primary" onClick={onModify} disabled={busy}>
            Modify
          </button>
        </>
      }
    >
      <ErrorBox error={error} />
      <dl className="act-rows">
        <dt>Type</dt>
        <dd>{ACTIVITY_TYPES.find((t) => t.value === activity.type)?.label ?? activity.type}</dd>
        <dt>Status</dt>
        <dd>
          <StatusBadge status={activity.status} extra={ACTIVITY_TONES} />
        </dd>
        <dt>When</dt>
        <dd>{when}</dd>
        {activity.location && (
          <>
            <dt>Where</dt>
            <dd>{activity.location}</dd>
          </>
        )}
        <dt>Who</dt>
        <dd>{activity.assignedTo.name}</dd>
        {(activity.lead || activity.quotation || activity.customer) && (
          <>
            <dt>Linked to</dt>
            <dd>
              {activity.lead && (
                <Link to={`/g-ops/leads/${activity.lead.id}`} onClick={onClose}>
                  {activity.lead.number} — {activity.lead.companyName}
                </Link>
              )}
              {activity.lead && activity.quotation && ' · '}
              {activity.quotation && (
                <Link to={`/g-ops/quotations/${activity.quotation.id}`} onClick={onClose}>
                  {activity.quotation.number}
                </Link>
              )}
              {(activity.lead || activity.quotation) && activity.customer && ' · '}
              {activity.customer && (
                <Link to={`/g-ops/customers/${activity.customer.id}`} onClick={onClose}>
                  {activity.customer.name}
                </Link>
              )}
            </dd>
          </>
        )}
        <dt>Reminder</dt>
        <dd>{REMINDERS.find((r) => r.value === String(activity.reminderMinutes ?? ''))?.label ?? 'No reminder'}</dd>
        {activity.notes && (
          <>
            <dt>Notes</dt>
            <dd className="act-notes">{activity.notes}</dd>
          </>
        )}
      </dl>

      <div className="act-rsvp-head">
        <h4>Invited{activity.invitees.length ? ` — ${summary}` : ''}</h4>
        {mine && planned && (
          <div className="act-rsvp-buttons" role="group" aria-label="Your answer">
            {ANSWERS.map((r) => (
              <button
                key={r}
                type="button"
                className={`btn btn-sm${mine.response === r ? ' btn-primary' : ''}`}
                aria-pressed={mine.response === r}
                disabled={busy}
                onClick={() => respond(r)}
              >
                {RSVP_LABEL[r]}
              </button>
            ))}
          </div>
        )}
      </div>
      {activity.invitees.length === 0 ? (
        <p className="faint">Nobody else was invited.</p>
      ) : (
        <div className="table-wrap">
          <table className="data act-rsvp-table">
            <thead>
              <tr>
                <th>Answer</th>
                <th>Who</th>
                <th>Answered</th>
              </tr>
            </thead>
            <tbody>
              {groups.map((g) => {
                const rows = activity.invitees.filter((i) => i.response === g.key);
                return rows.map((i, idx) => (
                  <tr key={i.userId}>
                    <td>
                      {idx === 0 && (
                        <span className={`act-rsvp-group ${g.cls}`}>
                          {RSVP_MARK[g.key]} {RSVP_LABEL[g.key]} ({rows.length})
                        </span>
                      )}
                    </td>
                    <td>
                      {i.user.name}
                      {i.userId === meId && <span className="faint"> (you)</span>}
                    </td>
                    <td className="faint">{i.respondedAt ? formatDateTime(i.respondedAt) : '—'}</td>
                  </tr>
                ));
              })}
            </tbody>
          </table>
        </div>
      )}
    </Modal>
  );
}

function ActivityModal({
  activity,
  people,
  defaultStart,
  onClose,
  onSaved,
}: {
  activity: Activity | null;
  people: Person[];
  defaultStart: Date;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { me } = useAuth();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [form, setForm] = useState({
    type: activity?.type ?? 'FOLLOW_UP',
    subject: activity?.subject ?? '',
    location: activity?.location ?? '',
    notes: activity?.notes ?? '',
    assignedToId: activity?.assignedTo.id ?? me?.user.id ?? '',
    leadId: activity?.lead?.id ?? '',
    quotationId: activity?.quotation?.id ?? '',
    customerId: activity?.customer?.id ?? '',
    startsAt: toLocalInput(activity ? new Date(activity.startsAt) : defaultStart),
    endsAt: toLocalInput(activity ? new Date(activity.endsAt) : new Date(defaultStart.getTime() + 3600000)),
    reminderMinutes: activity?.reminderMinutes != null ? String(activity.reminderMinutes) : '',
    inviteeIds: activity?.invitees.map((i) => i.userId) ?? ([] as string[]),
    status: activity?.status ?? 'PLANNED',
  });

  /** Moving the start keeps the length: Ends follows Starts, as a calendar's does. */
  function setStarts(value: string) {
    const oldStart = new Date(form.startsAt).getTime();
    const oldEnd = new Date(form.endsAt).getTime();
    const next = new Date(value).getTime();
    const length = Number.isFinite(oldEnd - oldStart) && oldEnd > oldStart ? oldEnd - oldStart : 3600000;
    setForm({ ...form, startsAt: value, endsAt: Number.isFinite(next) ? toLocalInput(new Date(next + length)) : form.endsAt });
  }
  const endsBeforeStart = !!form.startsAt && !!form.endsAt && new Date(form.endsAt) <= new Date(form.startsAt);

  /*
    The record links (lead, quotation, customer) are no longer picked here
    (2026-10-07, the owner's call): the calendar books time, and an activity
    gets its links where the record lives — the lead page's activity log, or
    a quotation's. One already linked keeps its links (the banner above says
    so), because the form never sends a value it did not load.
  */
  // Someone who has since lost calendar access is still who it was booked for.
  const peopleOptions =
    activity && !people.some((p) => p.id === activity.assignedTo.id) ? [activity.assignedTo, ...people] : people;
  // Invited people who have since lost calendar access stay on the list.
  const inviteOptions = [
    ...peopleOptions,
    ...(activity?.invitees ?? []).map((i) => i.user).filter((u) => !peopleOptions.some((p) => p.id === u.id)),
  ];

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const payload = {
        type: form.type,
        subject: form.subject,
        location: form.location || null,
        notes: form.notes || null,
        assignedToId: form.assignedToId,
        leadId: form.leadId || null,
        quotationId: form.quotationId || null,
        customerId: form.customerId || null,
        startsAt: new Date(form.startsAt).toISOString(),
        endsAt: new Date(form.endsAt).toISOString(),
        reminderMinutes: form.reminderMinutes ? Number(form.reminderMinutes) : null,
        inviteeIds: form.inviteeIds.filter((id) => id !== form.assignedToId),
        status: form.status,
      };
      if (activity) await api.patch(`/activities/${activity.id}`, payload);
      else await api.post('/activities', payload);
      onSaved();
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  }

  async function remove() {
    if (!activity) return;
    setBusy(true);
    try {
      await api.del(`/activities/${activity.id}`);
      onSaved();
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  }

  return (
    <Modal
      title={activity ? 'Modify activity' : 'Schedule activity'}
      onClose={onClose}
      footer={
        <>
          {activity && (
            <button type="button" className="btn btn-danger" onClick={remove} disabled={busy}>
              Remove
            </button>
          )}
          <div className="topbar-spacer" />
          <button type="button" className="btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-primary"
            onClick={save}
            disabled={busy || form.subject.length < 2 || endsBeforeStart}
          >
            {busy ? 'Saving…' : 'Save'}
          </button>
        </>
      }
    >
      <ErrorBox error={error} />

      {activity && (activity.lead || activity.quotation || activity.customer) && (
        <div className="alert info">
          Linked to{' '}
          {activity.lead && (
            <Link to={`/g-ops/leads/${activity.lead.id}`} onClick={onClose}>
              {activity.lead.number} — {activity.lead.companyName}
            </Link>
          )}
          {activity.lead && activity.quotation && ' · '}
          {activity.quotation && (
            <Link to={`/g-ops/quotations/${activity.quotation.id}`} onClick={onClose}>
              {activity.quotation.number}
            </Link>
          )}
          {(activity.lead || activity.quotation) && activity.customer && ' · '}
          {activity.customer && (
            <Link to={`/g-ops/customers/${activity.customer.id}`} onClick={onClose}>
              {activity.customer.name}
            </Link>
          )}
        </div>
      )}

      <div className="grid grid-2">
        <Field label="Type">
          <select value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })}>
            {ACTIVITY_TYPES.map((t) => (
              <option key={t.value} value={t.value}>
                {t.label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Who">
          <select
            value={form.assignedToId}
            onChange={(e) => setForm({ ...form, assignedToId: e.target.value })}
          >
            {peopleOptions.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </Field>
      </div>

      <Field label="What">
        <input value={form.subject} autoFocus onChange={(e) => setForm({ ...form, subject: e.target.value })} />
      </Field>

      <div className="grid grid-2">
        <Field label="Starts">
          <input type="datetime-local" value={form.startsAt} onChange={(e) => setStarts(e.target.value)} />
        </Field>
        <Field label="Ends" error={endsBeforeStart ? 'Ends must be after Starts' : null}>
          <input
            type="datetime-local"
            value={form.endsAt}
            min={form.startsAt}
            onChange={(e) => setForm({ ...form, endsAt: e.target.value })}
          />
        </Field>
      </div>

      <Field label="Reminder" hint="A notification — and an email where email is set up — to everyone on it">
        <select value={form.reminderMinutes} onChange={(e) => setForm({ ...form, reminderMinutes: e.target.value })}>
          {REMINDERS.map((r) => (
            <option key={r.value} value={r.value}>
              {r.label}
            </option>
          ))}
        </select>
      </Field>

      <Field label="Invite" hint="They are told when you save, and it shows on their calendar and in My Work">
        <PeoplePicker
          people={inviteOptions.map((p) => ({ id: p.id, name: p.name }))}
          value={form.inviteeIds}
          onChange={(ids) => setForm({ ...form, inviteeIds: ids })}
          exclude={[form.assignedToId]}
        />
      </Field>

      <Field label="Location">
        <input value={form.location} onChange={(e) => setForm({ ...form, location: e.target.value })} />
      </Field>
      <Field label="Notes">
        <textarea value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
      </Field>

      {activity && (
        <Field label="Status">
          <select value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value })}>
            <option value="PLANNED">Planned</option>
            <option value="DONE">Done</option>
            <option value="CANCELLED">Cancelled</option>
          </select>
        </Field>
      )}
    </Modal>
  );
}
