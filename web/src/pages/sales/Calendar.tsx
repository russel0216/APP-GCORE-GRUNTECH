import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { api, qs } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { dayKeyOf, parseDay, todayLocal, weekDays } from '../../lib/day';
import { blockSpan, minutesLabel, placeInLanes } from '../../lib/timeGrid';
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

/**
 * An activity type as Admin › Categories › Activity types has it (2026-10-08,
 * SCORO's customisable types). The list is data; an activity carries the key.
 */
interface ActivityTypeDef {
  id: string;
  key: string;
  name: string;
  color: string | null;
  isActive: boolean;
}

/** The six built-ins, standing in until the list loads. */
const BUILTIN_TYPES: ActivityTypeDef[] = [
  { id: 'SITE_VISIT', key: 'SITE_VISIT', name: 'Site visit', color: null, isActive: true },
  { id: 'MEETING', key: 'MEETING', name: 'Meeting', color: null, isActive: true },
  { id: 'CALL', key: 'CALL', name: 'Call', color: null, isActive: true },
  { id: 'FOLLOW_UP', key: 'FOLLOW_UP', name: 'Follow-up', color: null, isActive: true },
  { id: 'SUBMISSION', key: 'SUBMISSION', name: 'Submission', color: null, isActive: true },
  { id: 'OTHER', key: 'OTHER', name: 'Other', color: null, isActive: true },
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
  /** The type's key (SalesActivityType.key). */
  type: string;
  /** The type's name as Admin › Categories has it. */
  typeName?: string;
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

function toEvent(a: Activity, colors: Map<string, string>): CalendarEvent {
  const at = new Date(a.startsAt);
  const tally = tallyText(a);
  return {
    id: a.id,
    date: dayKeyOf(at),
    sortAt: at.getTime(),
    endAt: new Date(a.endsAt).getTime(),
    time: at.toLocaleTimeString('en-PH', { hour: '2-digit', minute: '2-digit' }),
    label: a.subject,
    detail: `${a.assignedTo.name}${tally ? ` · ${tally}` : ''}${
      a.lead ? ` · ${a.lead.companyName}` : a.customer ? ` · ${a.customer.name}` : ''
    }`,
    tone: statusTone(a.status, ACTIVITY_TONES),
    done: a.status !== 'PLANNED',
    color: colors.get(a.type),
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

/** A birthday or work anniversary (2026-10-08): derived from the employee record, never a table. */
interface Celebration {
  kind: 'BIRTHDAY' | 'ANNIVERSARY';
  employeeId: string;
  name: string;
  day: string;
  /** The age, or the years with the company. */
  years: number;
}

const PERSON_PREFIX = 'person:';

/** An all-day chip on the People layer: the name with the age or the years of tenure, as the owner asked. */
function celebrationToEvent(c: Celebration): CalendarEvent {
  const birthday = c.kind === 'BIRTHDAY';
  return {
    id: `${PERSON_PREFIX}${c.kind}:${c.employeeId}:${c.day}`,
    date: c.day,
    time: null,
    label: birthday ? `🎂 ${c.name} turns ${c.years}` : `🎉 ${c.name} · ${c.years} year${c.years === 1 ? '' : 's'} with us`,
    detail: birthday ? 'Birthday' : 'Work anniversary',
    tone: '',
  };
}

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
  /** A slot clicked on the time grid: the form opens on that time, an hour long. */
  const [newStart, setNewStart] = useState<Date | null>(null);
  /** The activity types as data; the built-ins stand in until they load. */
  const [types, setTypes] = useState<ActivityTypeDef[]>(BUILTIN_TYPES);
  const [tick, setTick] = useState(0);

  const { from, to, windowKey } = nav;

  useEffect(() => {
    api
      .get<ActivityTypeDef[]>('/reference/activity-types')
      .then((rows) => {
        if (rows.length) setTypes(rows);
      })
      .catch(() => {});
  }, []);
  const typeColors = useMemo(() => new Map(types.filter((t) => t.color).map((t) => [t.key, t.color!])), [types]);

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

  /*
    The People layer: birthdays and work anniversaries, on by default for
    everyone (the owner's call — the office knows who to greet), hidden with
    `?people=0` like the visits. Read from the employee records on the fly;
    nothing is stored.
  */
  const showPeople = params.get('people') !== '0';
  const [celebrations, setCelebrations] = useState<Celebration[]>([]);
  useEffect(() => {
    if (!showPeople) {
      setCelebrations([]);
      return;
    }
    let cancelled = false;
    api
      .get<{ celebrations: Celebration[] }>(`/employees/celebrations${qs({ from: dayKeyOf(from), to: dayKeyOf(to) })}`)
      .then((feed) => {
        if (!cancelled) setCelebrations(feed.celebrations);
      })
      .catch(() => {
        if (!cancelled) setCelebrations([]);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [windowKey, showPeople]);

  function togglePeople(on: boolean) {
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        if (on) next.delete('people');
        else next.set('people', '0');
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
    if (id.startsWith(PERSON_PREFIX)) {
      // The person's record, for whoever may open the register; otherwise the chip just says.
      const employeeId = id.split(':')[2];
      if (employeeId && can('ghr.employees.view_all')) navigate(`/g-hr/employees/${employeeId}`);
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
    setNewStart(null);
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
    () => [...activities.map((a) => toEvent(a, typeColors)), ...visits.map(visitToEvent), ...celebrations.map(celebrationToEvent)],
    [activities, visits, celebrations, typeColors],
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
        <Checkbox checked={showPeople} onChange={togglePeople} label="Birthdays & anniversaries" />
      </CalendarToolbar>

      <ErrorBox error={error} />

      {nav.view === 'month' ? (
        <MonthCalendar
          nav={nav}
          events={events}
          loading={loading}
          itemNoun={{ one: 'activity', many: 'activities' }}
          onDayClick={nav.goToDay}
          onEventClick={(e) => openEvent(e.id)}
        />
      ) : (
        <TimeGrid
          days={nav.view === 'day' ? [nav.day] : days}
          events={events}
          loading={loading}
          today={today}
          focus={nav.focus}
          onFocusDay={nav.setFocus}
          onOpenDay={nav.view === 'week' ? nav.goToDay : undefined}
          onEventClick={openEvent}
          onSlotClick={(day, minutes) => {
            const d = parseDay(day);
            d.setMinutes(minutes);
            setNewStart(d);
            setEditing('new');
          }}
        />
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
          types={types}
          defaultStart={newStart ?? defaultStart}
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

const HOURS = Array.from({ length: 24 }, (_, h) => h);

/**
 * The time grid (2026-10-08, SCORO's calendar): the day and week views on a
 * time scale. An hour gutter, a column per day, all-day items in a row over
 * the hours, and each activity a block sized by its Starts and Ends — blocks
 * that overlap share the column in lanes (`lib/timeGrid.ts`). A half-hour
 * slot shows "+" under the pointer and books that time; the blocks are
 * buttons, so the keyboard reaches every activity, while "+ Schedule" on the
 * focused day stays the keyboard's way to a new one.
 */
function TimeGrid({
  days,
  events,
  loading,
  today,
  focus,
  onFocusDay,
  onOpenDay,
  onEventClick,
  onSlotClick,
}: {
  days: string[];
  events: CalendarEvent[];
  loading: boolean;
  today: string;
  focus: string;
  onFocusDay: (day: string) => void;
  /** In the week view a day's head opens that day; the day view has none. */
  onOpenDay?: (day: string) => void;
  onEventClick: (id: string) => void;
  onSlotClick: (day: string, minutes: number) => void;
}) {
  const body = useRef<HTMLDivElement>(null);
  const daysKey = days.join(',');

  // Open on the working morning: 7:00 at the top, whichever day it is.
  useEffect(() => {
    const el = body.current;
    if (el) el.scrollTop = (el.scrollHeight / 24) * 7;
  }, [daysKey]);

  const columns = useMemo(
    () =>
      days.map((day) => {
        const dayStart = parseDay(day).getTime();
        const allDay = events.filter((e) => e.date === day && !e.time);
        const timed = events
          .filter((e) => e.time && e.sortAt !== undefined)
          .map((e) => {
            const span = blockSpan(e.sortAt!, e.endAt ?? e.sortAt! + 3_600_000, dayStart);
            return span ? { ...span, ev: e } : null;
          })
          .filter((b): b is { top: number; height: number; ev: CalendarEvent } => b !== null);
        return { day, allDay, blocks: placeInLanes(timed) };
      }),
    [days, events],
  );
  const now = new Date();
  const nowMinutes = now.getHours() * 60 + now.getMinutes();

  return (
    <div
      className="tg"
      style={{ '--tg-days': days.length } as React.CSSProperties}
      aria-busy={loading ? 'true' : undefined}
      aria-label={days.length === 1 ? 'Day' : 'Week'}
    >
      <div className="tg-head">
        <div className="tg-gutter" />
        {days.map((day) => {
          const date = parseDay(day);
          const isFocus = day === focus;
          return (
            <button
              key={day}
              type="button"
              className={`tg-day-head${day === today ? ' today' : ''}`}
              aria-pressed={isFocus}
              aria-label={`${date.toLocaleDateString('en-PH', { weekday: 'long', day: 'numeric', month: 'long' })}${
                onOpenDay ? ' — open this day' : ''
              }`}
              onClick={() => {
                onFocusDay(day);
                onOpenDay?.(day);
              }}
            >
              <span>{date.toLocaleDateString('en-PH', { weekday: 'short' })}</span>
              <strong>{date.getDate()}</strong>
              {days.length === 1 && <span>{date.toLocaleDateString('en-PH', { month: 'long', year: 'numeric' })}</span>}
            </button>
          );
        })}
      </div>
      <div className="tg-allday">
        <div className="tg-gutter">all day</div>
        {columns.map(({ day, allDay }) => (
          <div key={day} className="tg-allday-col">
            {allDay.map((e) => (
              <button
                key={e.id}
                type="button"
                className={`cal-item${e.done ? ' done' : ''}${e.id.startsWith(VISIT_PREFIX) ? ' service' : ''}${
                  e.id.startsWith(PERSON_PREFIX) ? ' people' : ''
                }`}
                onClick={() => onEventClick(e.id)}
              >
                <span>{e.label}</span>
                <span className="cal-item-sub">{e.detail}</span>
              </button>
            ))}
          </div>
        ))}
      </div>
      <div className="tg-body" ref={body}>
        <div className="tg-hours">
          {HOURS.map((h) => (
            <div key={h} className="tg-hour">
              <span>{h ? minutesLabel(h * 60) : ''}</span>
            </div>
          ))}
        </div>
        {columns.map(({ day, blocks }) => (
          <div key={day} className="tg-col" data-day={day}>
            {HOURS.flatMap((h) =>
              [0, 30].map((m) => {
                const minutes = h * 60 + m;
                return (
                  <button
                    key={minutes}
                    type="button"
                    tabIndex={-1}
                    className={`tg-slot${m === 0 ? ' hour' : ''}`}
                    aria-label={`Schedule ${parseDay(day).toLocaleDateString('en-PH', { weekday: 'short', day: 'numeric', month: 'short' })} at ${minutesLabel(minutes)}`}
                    onClick={() => onSlotClick(day, minutes)}
                  >
                    <span className="tg-plus" aria-hidden="true">
                      +
                    </span>
                  </button>
                );
              }),
            )}
            {blocks.map((b) => (
              <button
                key={b.ev.id}
                type="button"
                className={`tg-block${b.ev.done ? ' done' : ''}${b.ev.tone ? ` ${b.ev.tone}` : ''}`}
                style={
                  {
                    top: `calc(${b.top} / 60 * var(--cal-hour))`,
                    height: `calc(${b.height} / 60 * var(--cal-hour))`,
                    left: `${(b.lane / b.lanes) * 100}%`,
                    width: `${100 / b.lanes}%`,
                    ...(b.ev.color ? { '--type-color': b.ev.color } : {}),
                  } as React.CSSProperties
                }
                title={b.ev.detail ? `${b.ev.label} — ${b.ev.detail}` : b.ev.label}
                onClick={() => onEventClick(b.ev.id)}
              >
                <span className="tg-block-time">{b.ev.time}</span>
                <span>{b.ev.label}</span>
                {b.ev.detail && <span className="tg-block-sub">{b.ev.detail}</span>}
              </button>
            ))}
            {day === today && (
              <div className="tg-now" style={{ top: `calc(${nowMinutes} / 60 * var(--cal-hour))` }} aria-hidden="true" />
            )}
          </div>
        ))}
      </div>
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
        <dd>{activity.typeName ?? activity.type}</dd>
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
  types,
  defaultStart,
  onClose,
  onSaved,
}: {
  activity: Activity | null;
  people: Person[];
  /** The types on file; the form offers the active ones, plus the one the activity already has. */
  types: ActivityTypeDef[];
  defaultStart: Date;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { me } = useAuth();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const typeOptions = types.filter((t) => t.isActive || t.key === activity?.type);
  const [form, setForm] = useState({
    type: activity?.type ?? (typeOptions.some((t) => t.key === 'FOLLOW_UP') ? 'FOLLOW_UP' : (typeOptions[0]?.key ?? 'OTHER')),
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
            {typeOptions.map((t) => (
              <option key={t.key} value={t.key}>
                {t.name}
                {!t.isActive ? ' (no longer offered)' : ''}
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
