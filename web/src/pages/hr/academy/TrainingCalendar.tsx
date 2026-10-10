import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, downloadBlob, qs } from '../../../lib/api';
import { useAuth } from '../../../lib/auth';
import { CalendarToolbar, MonthCalendar, useCalendarNav, type CalendarEvent } from '../../../components/MonthCalendar';
import { Panel } from '../../../components/charts';
import { dayKeyOf, parseDay } from '../../../lib/day';
import { ErrorBox, Loading, Modal, ModalFoot, StatusBadge, formatSpan, statusTone, useToast } from '../../../components/ui';
import { RESULT_LABEL, RESULT_TONES, SESSION_TONES, SessionModal, type SessionDetailData } from './Sessions';

/**
 * Training Calendar — every scheduled session, company-wide (item 13).
 *
 * The month grid is the shared MonthCalendar (item 5's component) — there is
 * no second grid here. A chip opens the session in a modal, where an employee
 * can enrol themselves when HR allows it; a trainer or HR can book a new
 * session by pressing a day. The "This month" list beside it is the same
 * rows, readable without the grid.
 */

interface CalendarRow {
  id: string;
  number: string;
  status: string;
  date: string;
  sortAt: number;
  time: string;
  label: string;
  detail: string;
  done: boolean;
  startsAt: string;
  endsAt: string;
  venue: string | null;
  course: { id: string; code: string; title: string; category: string | null };
  trainerName: string;
  capacity: number | null;
  enrolledCount: number;
  enrolledMe: boolean;
  isTrainer: boolean;
  link: string;
}

/** Nine in the morning of a local day key — where a session booked from the grid starts. */
function atNine(day: string): Date {
  const d = parseDay(day);
  d.setHours(9, 0, 0, 0);
  return d;
}

export function TrainingCalendar() {
  const { can } = useAuth();
  const navigate = useNavigate();
  const nav = useCalendarNav({ defaultView: 'month', views: ['month'] });
  const [rows, setRows] = useState<CalendarRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [reload, setReload] = useState(0);
  const [preview, setPreview] = useState<string | null>(null);
  const [booking, setBooking] = useState<Date | null>(null);
  const [showCancelled, setShowCancelled] = useState(false);
  const { from, to, windowKey } = nav;
  const canCreate = can('ghr.training_sessions.create');

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api
      .get<CalendarRow[]>(
        `/training-sessions/calendar${qs({
          from: from.toISOString(),
          to: to.toISOString(),
          cancelled: showCancelled ? 'true' : undefined,
        })}`,
      )
      .then((r) => {
        if (cancelled) return;
        setRows(r);
        setError(null);
      })
      .catch((err) => !cancelled && setError(err))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
    // from/to are memoised on windowKey; the key is what names the window.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [windowKey, reload, showCancelled]);

  const events = useMemo<CalendarEvent[]>(
    () =>
      rows.map((r) => ({
        id: r.id,
        // MonthCalendar buckets on the viewer's local day; Manila's key is the fallback.
        date: dayKeyOf(new Date(r.startsAt)) || r.date,
        sortAt: r.sortAt,
        time: r.time,
        label: `${r.label}${r.status === 'CANCELLED' ? ' (cancelled)' : r.enrolledMe ? ' (you)' : ''}`,
        detail: r.detail,
        tone: statusTone(r.status, SESSION_TONES),
        done: r.done,
      })),
    [rows],
  );

  // "This month" is the month on show, not the padding days either side of it.
  const thisMonth = useMemo(
    () => rows.filter((r) => dayKeyOf(new Date(r.startsAt)).startsWith(nav.month)).sort((a, b) => a.sortAt - b.sortAt),
    [rows, nav.month],
  );

  return (
    <div>
      <div className="page-head">
        <h1>Training Calendar</h1>
        {canCreate && (
          <button type="button" className="btn btn-primary" onClick={() => setBooking(atNine(nav.focus))}>
            + New session
          </button>
        )}
      </div>

      <div className="academy-calendar">
        <div className="academy-calendar-main">
          <CalendarToolbar nav={nav}>
            <label className="checkbox">
              <input type="checkbox" checked={showCancelled} onChange={(e) => setShowCancelled(e.target.checked)} />
              <span>Show cancelled</span>
            </label>
          </CalendarToolbar>
          <ErrorBox error={error} />
          <MonthCalendar
            nav={nav}
            events={events}
            loading={loading}
            itemNoun={{ one: 'session', many: 'sessions' }}
            emptyNote={`No training sessions in ${nav.label}.`}
            onDayClick={canCreate ? (day) => setBooking(atNine(day)) : undefined}
            onEventClick={(e) => setPreview(e.id)}
          />
        </div>

        <Panel title="This month" blurb={thisMonth.length ? undefined : 'Nothing scheduled this month.'}>
          {thisMonth.length > 0 && (
            <ul className="academy-month-list">
              {thisMonth.map((r) => (
                <li key={r.id}>
                  <button type="button" className="academy-month-item" onClick={() => setPreview(r.id)}>
                    <span className="academy-month-title">{r.label}</span>
                    <span className="faint">
                      {formatSpan(r.startsAt, r.endsAt)} · {r.trainerName}
                    </span>
                    <span className="academy-month-meta">
                      <StatusBadge status={r.status} extra={SESSION_TONES} />
                      <span className="faint">
                        {r.enrolledCount}
                        {r.capacity ? `/${r.capacity}` : ''} enrolled
                        {r.enrolledMe ? ' · you' : ''}
                      </span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </div>

      {preview && (
        <SessionPreview
          id={preview}
          onClose={() => setPreview(null)}
          onChanged={() => setReload((n) => n + 1)}
          onOpen={(id) => navigate(`/g-hr/academy/sessions/${id}`)}
        />
      )}
      {booking && (
        <SessionModal
          startAt={booking}
          onClose={() => setBooking(null)}
          onSaved={(id) => {
            setBooking(null);
            setReload((n) => n + 1);
            navigate(`/g-hr/academy/sessions/${id}`);
          }}
        />
      )}
    </div>
  );
}

/**
 * A session at a glance, from the calendar. Somebody who holds only the
 * calendar right acts here — enrol, withdraw, take the .ics — since the
 * session screens are the trainer's.
 */
function SessionPreview({
  id,
  onClose,
  onChanged,
  onOpen,
}: {
  id: string;
  onClose: () => void;
  onChanged: () => void;
  onOpen: (id: string) => void;
}) {
  const { canView } = useAuth();
  const toast = useToast();
  const [s, setS] = useState<SessionDetailData | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    api
      .get<SessionDetailData>(`/training-sessions/${id}`)
      .then((r) => live && setS(r))
      .catch((err) => live && setError(err));
    return () => {
      live = false;
    };
  }, [id]);

  async function enrol(on: boolean) {
    if (!s) return;
    setBusy(true);
    setError(null);
    try {
      const next = on
        ? await api.post<SessionDetailData>(`/training-sessions/${s.id}/enrol-me`)
        : await api.del<SessionDetailData>(`/training-sessions/${s.id}/enrol-me`);
      setS(next);
      onChanged();
      toast('ok', on ? 'You are enrolled' : 'You are off the session');
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  const canOpen = canView('ghr', 'training_sessions');

  return (
    <Modal
      title={s ? s.course.title : 'Training session'}
      onClose={onClose}
      footer={
        <ModalFoot onCancel={onClose} cancelLabel="Close" busy={busy}>
          {s && (
            <>
              <button
                type="button"
                className="btn"
                onClick={() => downloadBlob(`/training-sessions/${s.id}/ics`, `${s.number}.ics`).catch(setError)}
              >
                Add to calendar (.ics)
              </button>
              {s.canWithdraw && (
                <button type="button" className="btn" onClick={() => enrol(false)} disabled={busy}>
                  Withdraw
                </button>
              )}
              {canOpen && (
                <button
                  type="button"
                  className={`btn${s.canSelfEnrol ? '' : ' btn-primary'}`}
                  onClick={() => onOpen(s.id)}
                >
                  Open session
                </button>
              )}
              {s.canSelfEnrol && (
                <button type="button" className="btn btn-primary" onClick={() => enrol(true)} disabled={busy}>
                  Enrol me
                </button>
              )}
            </>
          )}
        </ModalFoot>
      }
    >
      <ErrorBox error={error} />
      {!s ? (
        !error && <Loading />
      ) : (
        <div className="stack">
          <div className="row academy-split">
            <span className="mono">{s.number}</span>
            <StatusBadge status={s.status} extra={SESSION_TONES} />
          </div>
          <dl className="kv">
            <dt>When</dt>
            <dd>{formatSpan(s.startsAt, s.endsAt)}</dd>
            <dt>Where</dt>
            <dd>
              {s.venue ?? (s.meetLink ? 'Online — Google Meet' : '—')}
              {s.live && s.meetLink && (
                <>
                  {' · '}
                  <a href={s.meetLink} target="_blank" rel="noopener noreferrer">
                    Join now
                  </a>
                </>
              )}
            </dd>
            <dt>Trainer</dt>
            <dd>{s.isTrainer ? 'You' : s.trainer.name}</dd>
            <dt>Course</dt>
            <dd>
              {s.course.code} · {s.course.hours} h
              {s.course.validityMonths ? ` · valid ${s.course.validityMonths} months` : ''}
            </dd>
            <dt>Places</dt>
            <dd>
              {s.attendees.length} enrolled{s.capacity ? ` of ${s.capacity}` : ''}
              {s.full ? ' — full' : ''}
            </dd>
          </dl>
          {s.enrolled && (
            <div className="alert info">
              You are on this session
              {s.myResult && s.myResult !== 'PENDING' ? (
                <>
                  {' — '}
                  <StatusBadge status={s.myResult} extra={RESULT_TONES} label={RESULT_LABEL[s.myResult]} />
                </>
              ) : (
                '.'
              )}{' '}
              {!s.canWithdraw && s.status === 'SCHEDULED' && 'HR or the trainer enrolled you — ask them if you cannot make it.'}
            </div>
          )}
          {s.status === 'CANCELLED' && <div className="alert warn">Cancelled{s.cancelReason ? ` — ${s.cancelReason}` : ''}.</div>}
          {s.course.description && <p className="academy-prose">{s.course.description}</p>}
          {s.notes && <p className="academy-prose">{s.notes}</p>}
          {!s.enrolled && !s.canSelfEnrol && s.status === 'SCHEDULED' && !s.isTrainer && (
            <p className="faint">
              {s.full
                ? 'This session is full.'
                : new Date(s.startsAt).getTime() <= Date.now()
                  ? 'This session has started.'
                  : 'Ask HR or the trainer to enrol you.'}{' '}
              Your requirements are on <Link to="/g-hr/academy/passport">My Training Passport</Link>.
            </p>
          )}
        </div>
      )}
    </Modal>
  );
}
