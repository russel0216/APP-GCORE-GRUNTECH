import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, qs } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { ErrorBox, Field, Loading, Modal, useToast } from '../../components/ui';

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

function startOfWeek(date: Date): Date {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  // Monday-first: the working week people actually plan around.
  const day = (d.getDay() + 6) % 7;
  d.setDate(d.getDate() - day);
  return d;
}

/**
 * "One look at what all the sales personnel are going to do by day."
 *
 * A week grid with a column per day, not a month view — a month of tiny cells
 * tells you nothing about what anyone is doing on Thursday.
 */
export function SalesCalendar() {
  const navigate = useNavigate();
  const toast = useToast();
  const [anchor, setAnchor] = useState(() => startOfWeek(new Date()));
  const [activities, setActivities] = useState<Activity[]>([]);
  const [people, setPeople] = useState<{ id: string; name: string }[]>([]);
  const [who, setWho] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [editing, setEditing] = useState<Activity | 'new' | null>(null);

  const days = Array.from({ length: 7 }, (_, i) => {
    const d = new Date(anchor);
    d.setDate(d.getDate() + i);
    return d;
  });

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const to = new Date(anchor);
      to.setDate(to.getDate() + 7);
      setActivities(
        await api.get<Activity[]>(
          `/activities${qs({ from: anchor.toISOString(), to: to.toISOString(), assignedToId: who })}`,
        ),
      );
      setError(null);
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  }, [anchor, who]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    api
      .get<{ rows: { id: string; name: string }[] }>('/users?pageSize=200')
      .then((r) => setPeople(r.rows))
      .catch(() => {});
  }, []);

  function shift(weeks: number) {
    const d = new Date(anchor);
    d.setDate(d.getDate() + weeks * 7);
    setAnchor(d);
  }

  const today = new Date().toDateString();

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Sales Calendar</h1>
          <p>
            What everyone in sales is doing this week — site visits, follow-ups, submissions.
            Scheduling something for someone else notifies them.
          </p>
        </div>
        <button className="btn btn-primary" onClick={() => setEditing('new')}>
          + Schedule
        </button>
      </div>

      <div className="list-toolbar">
        <button className="btn btn-sm" onClick={() => shift(-1)}>
          ‹ Previous
        </button>
        <button className="btn btn-sm" onClick={() => setAnchor(startOfWeek(new Date()))}>
          This week
        </button>
        <button className="btn btn-sm" onClick={() => shift(1)}>
          Next ›
        </button>
        <span className="muted" style={{ marginLeft: 8 }}>
          {days[0].toLocaleDateString('en-PH', { day: 'numeric', month: 'short' })} —{' '}
          {days[6].toLocaleDateString('en-PH', { day: 'numeric', month: 'short', year: 'numeric' })}
        </span>
        <div className="topbar-spacer" />
        <select style={{ width: 'auto' }} value={who} onChange={(e) => setWho(e.target.value)}>
          <option value="">Everyone</option>
          {people.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </div>

      <ErrorBox error={error} />

      {loading ? (
        <Loading />
      ) : (
        <div className="calendar-week">
          {days.map((day) => {
            const items = activities.filter(
              (a) => new Date(a.startsAt).toDateString() === day.toDateString(),
            );
            return (
              <div key={day.toISOString()} className={`cal-day${day.toDateString() === today ? ' today' : ''}`}>
                <div className="cal-head">
                  <span>{day.toLocaleDateString('en-PH', { weekday: 'short' })}</span>
                  <strong>{day.getDate()}</strong>
                </div>
                <div className="cal-body">
                  {items.length === 0 ? (
                    <div className="faint" style={{ fontSize: 11, padding: 6 }}>
                      —
                    </div>
                  ) : (
                    items.map((a) => (
                      <div
                        key={a.id}
                        className={`cal-item${a.status === 'DONE' ? ' done' : ''}`}
                        onClick={() => setEditing(a)}
                      >
                        <div className="mono" style={{ fontSize: 10 }}>
                          {new Date(a.startsAt).toLocaleTimeString('en-PH', {
                            hour: '2-digit',
                            minute: '2-digit',
                          })}
                        </div>
                        <div>{a.subject}</div>
                        <div className="faint" style={{ fontSize: 10 }}>
                          {a.assignedTo.name}
                          {a.lead ? ` · ${a.lead.companyName}` : a.customer ? ` · ${a.customer.name}` : ''}
                        </div>
                      </div>
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
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            void load();
            toast('ok', 'Saved');
          }}
          onOpenRecord={(link) => navigate(link)}
        />
      )}
    </div>
  );
}

function ActivityModal({
  activity,
  people,
  onClose,
  onSaved,
  onOpenRecord,
}: {
  activity: Activity | null;
  people: { id: string; name: string }[];
  onClose: () => void;
  onSaved: () => void;
  onOpenRecord: (link: string) => void;
}) {
  const { me } = useAuth();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [leads, setLeads] = useState<{ id: string; number: string; companyName: string }[]>([]);
  const [form, setForm] = useState({
    type: activity?.type ?? 'FOLLOW_UP',
    subject: activity?.subject ?? '',
    location: activity?.location ?? '',
    notes: activity?.notes ?? '',
    assignedToId: activity?.assignedTo.id ?? me?.user.id ?? '',
    leadId: activity?.lead?.id ?? '',
    startsAt: activity
      ? new Date(new Date(activity.startsAt).getTime() - new Date().getTimezoneOffset() * 60000)
          .toISOString()
          .slice(0, 16)
      : new Date(Date.now() - new Date().getTimezoneOffset() * 60000 + 3600000)
          .toISOString()
          .slice(0, 16),
    durationMinutes: activity?.durationMinutes?.toString() ?? '60',
    status: activity?.status ?? 'PLANNED',
  });

  useEffect(() => {
    api
      .get<{ rows: { id: string; number: string; companyName: string }[] }>('/leads?pageSize=100')
      .then((r) => setLeads(r.rows))
      .catch(() => {});
  }, []);

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
            <button className="btn btn-danger" onClick={remove} disabled={busy}>
              Remove
            </button>
          )}
          <div style={{ flex: 1 }} />
          <button className="btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button className="btn btn-primary" onClick={save} disabled={busy || form.subject.length < 2}>
            {busy ? 'Saving…' : 'Save'}
          </button>
        </>
      }
    >
      <ErrorBox error={error} />

      {activity?.lead && (
        <div className="alert info">
          Linked to{' '}
          <a onClick={() => onOpenRecord(`/g-ops/leads/${activity.lead!.id}`)} style={{ cursor: 'pointer' }}>
            {activity.lead.number} — {activity.lead.companyName}
          </a>
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
            {people.map((p) => (
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

      <Field label="Lead">
        <select value={form.leadId} onChange={(e) => setForm({ ...form, leadId: e.target.value })}>
          <option value="">— not linked —</option>
          {leads.map((l) => (
            <option key={l.id} value={l.id}>
              {l.number} — {l.companyName}
            </option>
          ))}
        </select>
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
