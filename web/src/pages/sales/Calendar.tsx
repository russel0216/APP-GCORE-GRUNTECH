import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api, qs } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { dayKeyOf, parseDay, todayLocal, weekDays } from '../../lib/day';
import { ErrorBox, Field, Modal, statusTone, useToast } from '../../components/ui';
import {
  CalendarToolbar,
  MonthCalendar,
  useCalendarNav,
  type CalendarEvent,
} from '../../components/MonthCalendar';

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

interface Activity {
  id: string;
  type: string;
  status: string;
  subject: string;
  notes: string | null;
  location: string | null;
  startsAt: string;
  durationMinutes: number;
  assignedTo: { id: string; name: string };
  lead: { id: string; number: string; companyName: string } | null;
  quotation: { id: string; number: string } | null;
  customer: { id: string; name: string } | null;
}

interface Person {
  id: string;
  name: string;
}

function toEvent(a: Activity): CalendarEvent {
  const at = new Date(a.startsAt);
  return {
    id: a.id,
    date: dayKeyOf(at),
    sortAt: at.getTime(),
    time: at.toLocaleTimeString('en-PH', { hour: '2-digit', minute: '2-digit' }),
    label: a.subject,
    detail: `${a.assignedTo.name}${a.lead ? ` · ${a.lead.companyName}` : a.customer ? ` · ${a.customer.name}` : ''}`,
    tone: statusTone(a.status, ACTIVITY_TONES),
    done: a.status !== 'PLANNED',
  };
}

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
  const nav = useCalendarNav({ defaultView: 'week' });
  const [params, setParams] = useSearchParams();
  const [activities, setActivities] = useState<Activity[]>([]);
  const [people, setPeople] = useState<Person[]>([]);
  const [who, setWho] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [editing, setEditing] = useState<Activity | 'new' | null>(null);
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
  useEffect(() => {
    // Not consumed here: StrictMode runs this twice and cancels the first,
    // so clearing the ref would leave the second run with nothing to open.
    const id = linked.current;
    if (!id) return;
    let cancelled = false;
    api
      .get<Activity>(`/activities/${encodeURIComponent(id)}`)
      .then((found) => {
        if (cancelled) return;
        const day = dayKeyOf(new Date(found.startsAt));
        if (nav.view === 'week' && weekDays(nav.week).includes(day)) nav.setFocus(day);
        else nav.goToWeekOf(day);
        setEditing(found);
      })
      .catch(() => {
        if (!cancelled) toast('error', 'That activity no longer exists');
      });
    return () => {
      cancelled = true;
    };
    // Once, on mount: the id is consumed and the modal owns what happens next.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function closeModal() {
    setEditing(null);
    if (params.has('activity')) {
      setParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          next.delete('activity');
          return next;
        },
        { replace: true },
      );
    }
  }

  const events = useMemo(() => activities.map(toEvent), [activities]);
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
            submissions. Scheduling something for someone else notifies them.
          </p>
        </div>
        <button type="button" className="btn btn-primary" onClick={() => setEditing('new')}>
          + Schedule
        </button>
      </div>

      <CalendarToolbar nav={nav}>
        <select
          className="cal-person"
          aria-label="Whose activities"
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
      </CalendarToolbar>

      <ErrorBox error={error} />

      {nav.view === 'month' ? (
        <MonthCalendar
          nav={nav}
          events={events}
          loading={loading}
          itemNoun={{ one: 'activity', many: 'activities' }}
          onDayClick={nav.goToWeekOf}
          onEventClick={(e) => {
            const a = byId.get(e.id);
            if (a) setEditing(a);
          }}
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
                        className={`cal-item${e.done ? ' done' : ''}`}
                        onClick={() => {
                          const a = byId.get(e.id);
                          if (a) setEditing(a);
                        }}
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

      {editing && (
        <ActivityModal
          activity={editing === 'new' ? null : editing}
          people={people}
          defaultStart={defaultStart}
          onClose={closeModal}
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

interface LeadOption {
  id: string;
  number: string;
  companyName: string;
  status: string;
}

interface QuotationOption {
  id: string;
  number: string;
  subject: string;
}

interface CustomerOption {
  id: string;
  code: string;
  name: string;
}

/** The stages an activity can still be scheduled against — a closed lead has nothing to do. */
const CLOSED_LEAD = new Set(['WON', 'LOST']);

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
  const [leads, setLeads] = useState<LeadOption[]>([]);
  const [quotations, setQuotations] = useState<QuotationOption[]>([]);
  const [customers, setCustomers] = useState<CustomerOption[]>([]);
  const [leadQ, setLeadQ] = useState('');
  const [quotationQ, setQuotationQ] = useState('');
  const [customerQ, setCustomerQ] = useState('');
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
    durationMinutes: activity?.durationMinutes?.toString() ?? '60',
    status: activity?.status ?? 'PLANNED',
  });

  // Leads, quotations and customers are searched, not listed: all three grow
  // without bound, and a plain select of the first page would hide the rest.
  useEffect(() => {
    const t = setTimeout(() => {
      api
        .get<{ rows: LeadOption[] }>(`/leads${qs({ pageSize: 50, search: leadQ })}`)
        .then((r) => setLeads(r.rows))
        .catch(() => {});
    }, 220);
    return () => clearTimeout(t);
  }, [leadQ]);

  useEffect(() => {
    const t = setTimeout(() => {
      api
        .get<{ rows: QuotationOption[] }>(`/quotations${qs({ pageSize: 50, search: quotationQ })}`)
        .then((r) => setQuotations(r.rows))
        .catch(() => {});
    }, 220);
    return () => clearTimeout(t);
  }, [quotationQ]);

  useEffect(() => {
    const t = setTimeout(() => {
      api
        .get<CustomerOption[]>(`/customers/lookup${qs({ q: customerQ })}`)
        .then(setCustomers)
        .catch(() => {});
    }, 220);
    return () => clearTimeout(t);
  }, [customerQ]);

  // A closed lead is not offered, but one already linked stays selectable so
  // editing the activity never silently unlinks it.
  const openLeads = leads.filter((l) => !CLOSED_LEAD.has(l.status) || l.id === form.leadId);
  const leadOptions =
    activity?.lead && !openLeads.some((l) => l.id === activity.lead!.id)
      ? [{ ...activity.lead, status: '' }, ...openLeads]
      : openLeads;
  // Someone who has since lost calendar access is still who it was booked for.
  const peopleOptions =
    activity && !people.some((p) => p.id === activity.assignedTo.id) ? [activity.assignedTo, ...people] : people;
  const quotationOptions =
    activity?.quotation && !quotations.some((q) => q.id === activity.quotation!.id)
      ? [{ id: activity.quotation.id, number: activity.quotation.number, subject: '' }, ...quotations]
      : quotations;
  const customerOptions =
    activity?.customer && !customers.some((c) => c.id === activity.customer!.id)
      ? [{ id: activity.customer.id, code: '', name: activity.customer.name }, ...customers]
      : customers;

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
        durationMinutes: Number(form.durationMinutes),
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
            disabled={busy || form.subject.length < 2}
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
        <Field label="When">
          <input
            type="datetime-local"
            value={form.startsAt}
            onChange={(e) => setForm({ ...form, startsAt: e.target.value })}
          />
        </Field>
        <Field label="Minutes">
          <input
            type="number"
            value={form.durationMinutes}
            onChange={(e) => setForm({ ...form, durationMinutes: e.target.value })}
          />
        </Field>
      </div>

      <Field label="Lead" hint="Open leads only — a won or lost lead has nothing left to schedule.">
        <div className="cal-picker">
          <input
            type="search"
            placeholder="Search leads…"
            aria-label="Search leads"
            value={leadQ}
            onChange={(e) => setLeadQ(e.target.value)}
          />
          <select
            aria-label="Lead"
            value={form.leadId}
            onChange={(e) => setForm({ ...form, leadId: e.target.value })}
          >
            <option value="">— not linked —</option>
            {leadOptions.map((l) => (
              <option key={l.id} value={l.id}>
                {l.number} — {l.companyName}
              </option>
            ))}
          </select>
        </div>
      </Field>

      <div className="grid grid-2">
        <Field label="Quotation">
          <div className="cal-picker">
            <input
              type="search"
              placeholder="Search quotations…"
              aria-label="Search quotations"
              value={quotationQ}
              onChange={(e) => setQuotationQ(e.target.value)}
            />
            <select
              aria-label="Quotation"
              value={form.quotationId}
              onChange={(e) => setForm({ ...form, quotationId: e.target.value })}
            >
              <option value="">— not linked —</option>
              {quotationOptions.map((q) => (
                <option key={q.id} value={q.id}>
                  {q.number}
                  {q.subject ? ` — ${q.subject}` : ''}
                </option>
              ))}
            </select>
          </div>
        </Field>
        <Field label="Customer">
          <div className="cal-picker">
            <input
              type="search"
              placeholder="Search customers…"
              aria-label="Search customers"
              value={customerQ}
              onChange={(e) => setCustomerQ(e.target.value)}
            />
            <select
              aria-label="Customer"
              value={form.customerId}
              onChange={(e) => setForm({ ...form, customerId: e.target.value })}
            >
              <option value="">— not linked —</option>
              {customerOptions.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.code ? `${c.code} — ` : ''}
                  {c.name}
                </option>
              ))}
            </select>
          </div>
        </Field>
      </div>

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
