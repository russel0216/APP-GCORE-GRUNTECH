import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { api, qs } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { dayKeyOf, parseDay, todayLocal, weekDays } from '../../lib/day';
import { blockSpan, minutesLabel, placeInLanes } from '../../lib/timeGrid';
import { Checkbox, ErrorBox, statusTone, useToast } from '../../components/ui';
import { KIND_LABEL } from '../service/Reports';
import {
  CalendarToolbar,
  MonthCalendar,
  useCalendarNav,
  type CalendarEvent,
} from '../../components/MonthCalendar';
import { usePeople } from '../../components/People';
import { ActivityModal } from './ActivityForm';
import { ACTIVITY_TONES, BUILTIN_TYPES, type Activity, type ActivityTypeDef, type Rsvp } from './activityShared';

// ════════════════════════════════════════════════════════════════════
//  SALES CALENDAR
// ════════════════════════════════════════════════════════════════════

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
    // An all-day activity (SCORO's "All day") sits in the all-day row, like a service visit.
    time: a.allDay ? null : at.toLocaleTimeString('en-PH', { hour: '2-digit', minute: '2-digit' }),
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
  const { can } = useAuth();
  const navigate = useNavigate();
  const nav = useCalendarNav({ defaultView: 'week' });
  const [params, setParams] = useSearchParams();
  const [activities, setActivities] = useState<Activity[]>([]);
  const [visits, setVisits] = useState<ServiceVisitChip[]>([]);
  // On by default for anyone who may see the schedule; `?visits=0` hides it,
  // in the URL like the view, so a shared link shows what its sender saw.
  const canVisits = can('gops.visits.view_all');
  const showVisits = canVisits && params.get('visits') !== '0';
  // Only people who can open this calendar can be booked on it.
  const { people } = usePeople('gops.calendar.view_all');
  const [who, setWho] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [editing, setEditing] = useState<Activity | 'new' | null>(null);
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
    // An activity opens its own page (2026-10-08, SCORO's event page), never the form.
    navigate(`/g-ops/calendar/activities/${encodeURIComponent(id)}`);
  }

  /*
    An older link — `?activity=<id>&date=<day>`, where notifications used to
    land — goes on to the activity's own page, carrying `?respond=` (the
    invitation email's answer) with it. Notifications now link to the page
    directly (`activityLink` in shared/activities.ts).
  */
  const linked = useRef<string | null>(params.get('activity'));
  useEffect(() => {
    const id = linked.current;
    if (!id) return;
    const respond = params.get('respond');
    navigate(`/g-ops/calendar/activities/${encodeURIComponent(id)}${qs({ respond })}`, { replace: true });
    // Once, on mount: the page owns what happens next.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function closeModal() {
    setEditing(null);
    setNewStart(null);
  }

  const events = useMemo(
    () => [...activities.map((a) => toEvent(a, typeColors)), ...visits.map(visitToEvent), ...celebrations.map(celebrationToEvent)],
    [activities, visits, celebrations, typeColors],
  );
  const today = todayLocal();
  const days = useMemo(() => weekDays(nav.week), [nav.week]);

  /*
    "+ New activity" proposes the day the person is looking at. Today keeps
    the old "an hour from now"; any other focused day starts at nine.
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
          + New activity
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

      {editing && (
        <ActivityModal
          activity={editing === 'new' ? null : editing}
          people={people}
          types={types}
          defaultStart={newStart ?? defaultStart}
          onClose={closeModal}
          onSaved={(saved, action) => {
            setTick((t) => t + 1);
            toast('ok', action === 'another' ? 'Saved — add the next one' : 'Saved');
            if (action === 'open') navigate(`/g-ops/calendar/activities/${saved.id}`);
            else if (action === 'close') closeModal();
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
 * buttons, so the keyboard reaches every activity, while "+ New activity" on
 * the focused day stays the keyboard's way to a new one.
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
