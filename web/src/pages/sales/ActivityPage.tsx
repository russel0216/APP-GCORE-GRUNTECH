import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api, qs } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { dayKeyOf } from '../../lib/day';
import { Attachments } from '../../components/Attachments';
import { Avatar, ErrorBox, Loading, StatusBadge, formatDateTime, useToast } from '../../components/ui';
import { ActivityModal } from './ActivityForm';
import {
  ACTIVITY_TONES,
  ANSWERS,
  BUILTIN_TYPES,
  REMINDERS,
  RSVP_LABEL,
  RSVP_MARK,
  type Activity,
  type ActivityTypeDef,
  type Person,
  type Rsvp,
} from './activityShared';

// ════════════════════════════════════════════════════════════════════
//  THE ACTIVITY'S PAGE  (2026-10-08, SCORO's event page)
// ════════════════════════════════════════════════════════════════════

/*
  Clicking an activity on the calendar opens this page — SCORO's event page,
  the owner's second screenshot: the date as a block, the title, the status
  and type, when and for how long, where, who is on it as faces, "Open in
  Google Calendar", the description, the files — and what SCORO lacked, the
  answers as a table: Going / Maybe / Not going / No reply, with when each
  was given. An invitee answers here; whoever may open the calendar modifies
  (the form), marks it done or cancels it. `?respond=` from the invitation
  email records the answer on opening, for the invitee only.
*/

/** The class the answer's colour comes from (readable without it: the mark and the word are there). */
const RSVP_CLASS: Record<Rsvp, string> = { ACCEPTED: 'going', TENTATIVE: 'maybe', DECLINED: 'not-going', PENDING: 'no-reply' };

/** "8h 00min", as SCORO prints a duration; a whole day or more says so. */
export function durationLabel(minutes: number): string {
  const days = Math.floor(minutes / 1440);
  const h = Math.floor((minutes % 1440) / 60);
  const m = minutes % 60;
  if (days && !h && !m) return `${days} day${days === 1 ? '' : 's'}`;
  const hm = `${h}h ${String(m).padStart(2, '0')}min`;
  return days ? `${days}d ${hm}` : hm;
}

/** The faces strip names people by their first name, as SCORO does; the full name is in the tooltip. */
function firstName(name: string): string {
  return name.trim().split(/\s+/)[0] ?? name;
}

function timeOf(d: Date): string {
  return d.toLocaleTimeString('en-PH', { hour: '2-digit', minute: '2-digit' });
}

export function ActivityPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const { me } = useAuth();
  const toast = useToast();
  const meId = me?.user.id ?? '';

  const [activity, setActivity] = useState<Activity | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [actionError, setActionError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [people, setPeople] = useState<Person[]>([]);
  const [types, setTypes] = useState<ActivityTypeDef[]>(BUILTIN_TYPES);

  const load = useCallback(async () => {
    if (!id) return;
    try {
      setActivity(await api.get<Activity>(`/activities/${encodeURIComponent(id)}`));
      setError(null);
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  }, [id]);

  /*
    `?respond=ACCEPTED|TENTATIVE|DECLINED` comes from the invitation email's
    links: the answer is recorded on opening, for an invitee of a planned
    activity only, and the key drops out of the URL. Read once, on mount;
    the page owns what happens next.
  */
  const linkedAnswer = useRef<Rsvp | null>(
    (ANSWERS as string[]).includes(params.get('respond') ?? '') ? (params.get('respond') as Rsvp) : null,
  );
  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    const answer = linkedAnswer.current;
    (async () => {
      try {
        let found = await api.get<Activity>(`/activities/${encodeURIComponent(id)}`);
        if (answer && found.status === 'PLANNED' && found.invitees.some((i) => i.userId === meId)) {
          try {
            await api.post(`/activities/${encodeURIComponent(id)}/respond`, { response: answer });
            toast('ok', `Marked as ${RSVP_LABEL[answer].toLowerCase()}`);
            found = await api.get<Activity>(`/activities/${encodeURIComponent(id)}`);
          } catch {
            toast('error', 'Your answer was not recorded — use the buttons on the page');
          }
        }
        if (cancelled) return;
        setActivity(found);
        setError(null);
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
      } catch (err) {
        if (!cancelled) setError(err);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // Once per activity: the answer is consumed on the first read.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  // The form's lists: who may be booked (people who can open the calendar) and the types on offer.
  useEffect(() => {
    api
      .get<Person[]>(`/users/lookup${qs({ holding: 'gops.calendar.view_all' })}`)
      .then((rows) => setPeople(rows.map((p) => ({ id: p.id, name: p.name, photoPath: p.photoPath ?? null }))))
      .catch(() => {});
    api
      .get<ActivityTypeDef[]>('/reference/activity-types')
      .then((rows) => {
        if (rows.length) setTypes(rows);
      })
      .catch(() => {});
  }, []);

  if (loading) return <Loading />;
  if (!activity) return <ErrorBox error={error ?? new Error('Activity not found')} />;

  const planned = activity.status === 'PLANNED';
  const mine = activity.invitees.find((i) => i.userId === meId) ?? null;
  const start = new Date(activity.startsAt);
  const end = new Date(activity.endsAt);
  const dayKey = dayKeyOf(start);
  const sameDay = dayKey === dayKeyOf(end);
  const whenText = sameDay ? `${timeOf(start)} – ${timeOf(end)}` : `${formatDateTime(start)} – ${formatDateTime(end)}`;
  const calendarPath = `/g-ops/calendar${qs({ view: 'day', day: dayKey })}`;

  const n = (r: Rsvp) => activity.invitees.filter((i) => i.response === r).length;
  const summary = [
    `${n('ACCEPTED')} going`,
    n('TENTATIVE') ? `${n('TENTATIVE')} maybe` : null,
    `${n('DECLINED')} not going`,
    `${n('PENDING')} no reply`,
  ]
    .filter(Boolean)
    .join(' · ');
  const groups: Rsvp[] = ['ACCEPTED', 'TENTATIVE', 'DECLINED', 'PENDING'];

  async function run(fn: () => Promise<unknown>, done: string) {
    setBusy(true);
    setActionError(null);
    try {
      await fn();
      toast('ok', done);
      await load();
    } catch (err) {
      setActionError(err);
    } finally {
      setBusy(false);
      setConfirmCancel(false);
    }
  }
  const respond = (r: Rsvp) =>
    run(() => api.post(`/activities/${activity.id}/respond`, { response: r }), `Marked as ${RSVP_LABEL[r].toLowerCase()}`);
  const markDone = () => run(() => api.patch(`/activities/${activity.id}`, { status: 'DONE' }), 'Marked done');
  const cancel = () =>
    run(() => api.patch(`/activities/${activity.id}`, { status: 'CANCELLED' }), 'Cancelled — everyone on it is told');

  const linked = activity.lead || activity.quotation || activity.customer;

  return (
    <div className="act-page">
      <div className="breadcrumb">
        <Link to={calendarPath}>Sales Calendar</Link>
        <span className="sep">›</span>
        <span>{activity.subject}</span>
      </div>

      <header className="act-head card">
        <div className="act-date" title={start.toLocaleDateString('en-PH', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })}>
          <span className="act-date-month">{start.toLocaleDateString('en-PH', { month: 'short' }).toUpperCase()}</span>
          <span className="act-date-day">{String(start.getDate()).padStart(2, '0')}</span>
          <span className="act-date-dow">{start.toLocaleDateString('en-PH', { weekday: 'long' })}</span>
        </div>
        <div className="act-head-main">
          <h1>{activity.subject}</h1>
          <div className="act-head-tags">
            <StatusBadge status={activity.status} extra={ACTIVITY_TONES} />
            <span className="act-type">{activity.typeName ?? activity.type}</span>
            {activity.isPrivate && (
              <span className="act-tag" title="Only the people on it see what it is">
                Private
              </span>
            )}
            {activity.seriesId && (
              <span className="act-tag" title="One of a repeating booking">
                Repeats
              </span>
            )}
          </div>
          <p className="act-when">
            <strong>{activity.allDay ? (activity.durationMinutes > 1440 ? `All day, ${activity.durationMinutes / 1440} days` : 'All day') : whenText}</strong>
            {!activity.allDay && <span className="faint"> · {durationLabel(activity.durationMinutes)}</span>}
          </p>
          {activity.location && <p className="act-where">{activity.location}</p>}
          {activity.masked && <p className="faint">A private activity — only the people on it see the details.</p>}
          {activity.callLink && (
            <p className="act-call">
              <a className="btn btn-sm" href={activity.callLink} target="_blank" rel="noopener noreferrer">
                Join the call ↗
              </a>
            </p>
          )}
        </div>
        <div className="act-head-actions">
          {activity.masked ? null : planned &&
            (confirmCancel ? (
              <>
                <span className="act-confirm">Cancel this activity? Everyone on it is told.</span>
                <button type="button" className="btn btn-danger" onClick={cancel} disabled={busy}>
                  Yes, cancel it
                </button>
                <button type="button" className="btn" onClick={() => setConfirmCancel(false)} disabled={busy}>
                  Keep it
                </button>
              </>
            ) : (
              <>
                <button type="button" className="btn" onClick={markDone} disabled={busy}>
                  Mark done
                </button>
                <button type="button" className="btn btn-danger" onClick={() => setConfirmCancel(true)} disabled={busy}>
                  Cancel activity
                </button>
              </>
            ))}
          {!activity.masked && (
            <button type="button" className="btn btn-primary" onClick={() => setEditing(true)} disabled={busy}>
              Modify
            </button>
          )}
        </div>
      </header>

      <ErrorBox error={actionError} />

      {!activity.masked && (
        <>
      <section className="card act-people">
        <div className="act-section-head">
          <h3>Participants</h3>
          {activity.googleCalendarUrl && (
            <a className="btn btn-sm" href={activity.googleCalendarUrl} target="_blank" rel="noopener noreferrer">
              Open in Google Calendar ↗
            </a>
          )}
        </div>
        <ul className="act-faces">
          <li className="act-face" title={`${activity.assignedTo.name} — booked for`} aria-label={`${activity.assignedTo.name}, booked for`}>
            <Avatar name={activity.assignedTo.name} photoId={activity.assignedTo.photoPath} size={44} />
            <span className="act-face-name">{firstName(activity.assignedTo.name)}</span>
            <span className="act-face-sub">Booked for</span>
          </li>
          {activity.invitees.map((i) => (
            <li
              key={i.userId}
              className="act-face"
              title={`${i.user.name} — ${RSVP_LABEL[i.response]}`}
              aria-label={`${i.user.name}, ${RSVP_LABEL[i.response].toLowerCase()}`}
            >
              <Avatar name={i.user.name} photoId={i.user.photoPath} size={44} />
              <span className="act-face-name">
                {firstName(i.user.name)}
                {i.userId === meId ? ' (you)' : ''}
              </span>
              <span className={`act-face-sub act-rsvp-group ${RSVP_CLASS[i.response]}`}>
                {RSVP_MARK[i.response]} {RSVP_LABEL[i.response]}
              </span>
            </li>
          ))}
        </ul>
      </section>

      <div className="grid grid-2 act-columns">
        <section className="card">
          <h3>Details</h3>
          <dl className="act-rows">
            <dt>When</dt>
            <dd>
              {formatDateTime(start)} – {sameDay ? timeOf(end) : formatDateTime(end)}
              <span className="faint"> · {durationLabel(activity.durationMinutes)}</span>
            </dd>
            <dt>Where</dt>
            <dd>{activity.location || <span className="faint">—</span>}</dd>
            <dt>Booked for</dt>
            <dd>
              {activity.assignedTo.name}
              {activity.createdBy && activity.createdBy.id !== activity.assignedTo.id && (
                <span className="faint"> · booked by {activity.createdBy.name}</span>
              )}
            </dd>
            {activity.contact && (
              <>
                <dt>Contact person</dt>
                <dd>
                  {activity.contact.name}
                  {activity.contact.position && <span className="faint"> · {activity.contact.position}</span>}
                </dd>
              </>
            )}
            {activity.job && (
              <>
                <dt>Project</dt>
                <dd>
                  <Link to={`/g-ops/projects/${activity.job.id}`}>
                    {activity.job.number} — {activity.job.name}
                  </Link>
                </dd>
              </>
            )}
            <dt>Linked to</dt>
            <dd>
              {linked ? (
                <>
                  {activity.lead && (
                    <Link to={`/g-ops/leads/${activity.lead.id}`}>
                      {activity.lead.number} — {activity.lead.companyName}
                    </Link>
                  )}
                  {activity.lead && activity.quotation && ' · '}
                  {activity.quotation && <Link to={`/g-ops/quotations/${activity.quotation.id}`}>{activity.quotation.number}</Link>}
                  {(activity.lead || activity.quotation) && activity.customer && ' · '}
                  {activity.customer && <Link to={`/g-ops/customers/${activity.customer.id}`}>{activity.customer.name}</Link>}
                </>
              ) : (
                <span className="faint">Nothing — links are added where the record lives</span>
              )}
            </dd>
            <dt>Reminder</dt>
            <dd>{REMINDERS.find((r) => r.value === String(activity.reminderMinutes ?? ''))?.label ?? 'No reminder'}</dd>
          </dl>
        </section>

        <section className="card">
          <h3>Description</h3>
          {activity.notes ? <p className="act-notes">{activity.notes}</p> : <p className="faint">Nothing written.</p>}
        </section>
      </div>

      <section className="card">
        <div className="act-section-head">
          <h3>Responses{activity.invitees.length ? ` — ${summary}` : ''}</h3>
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
                  const rows = activity.invitees.filter((i) => i.response === g);
                  return rows.map((i, idx) => (
                    <tr key={i.userId}>
                      <td>
                        {idx === 0 && (
                          <span className={`act-rsvp-group ${RSVP_CLASS[g]}`}>
                            {RSVP_MARK[g]} {RSVP_LABEL[g]} ({rows.length})
                          </span>
                        )}
                      </td>
                      <td>
                        <span className="act-who">
                          <Avatar name={i.user.name} photoId={i.user.photoPath} size={24} />
                          {i.user.name}
                          {i.userId === meId && <span className="faint"> (you)</span>}
                        </span>
                      </td>
                      <td className="faint">{i.respondedAt ? formatDateTime(i.respondedAt) : '—'}</td>
                    </tr>
                  ));
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <Attachments entityType="sales_activity" entityId={activity.id} title="Files" hint="Agenda, directions, a photo from the site — anything the people on it need." />
        </>
      )}

      {editing && !activity.masked && (
        <ActivityModal
          activity={activity}
          people={people}
          types={types}
          defaultStart={start}
          onClose={() => setEditing(false)}
          onSaved={() => {
            setEditing(false);
            toast('ok', 'Saved');
            void load();
          }}
          onRemoved={(removed) => {
            toast('ok', removed > 1 ? `Removed ${removed} occurrences` : 'Removed');
            navigate(calendarPath, { replace: true });
          }}
        />
      )}
    </div>
  );
}
