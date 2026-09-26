import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, qs } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { Empty, ErrorBox, Field, Loading, Modal, formatMoney, useToast } from '../../components/ui';

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

// ════════════════════════════════════════════════════════════════════
//  PIPELINE
// ════════════════════════════════════════════════════════════════════

interface Card {
  id: string;
  kind: 'lead' | 'quotation';
  title: string;
  subtitle: string;
  amount: number;
  probability: number;
  weighted: number;
  owner: { id: string; name: string } | null;
  link: string;
}

interface Stage {
  key: string;
  label: string;
  cards: Card[];
  count: number;
  value: number;
  weighted: number;
}

export function Pipeline() {
  const [stages, setStages] = useState<Stage[]>([]);
  const [people, setPeople] = useState<{ id: string; name: string }[]>([]);
  const [owner, setOwner] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.get<{ stages: Stage[] }>(`/pipeline${qs({ ownerId: owner })}`);
      setStages(res.stages);
      setError(null);
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  }, [owner]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    api
      .get<{ rows: { id: string; name: string }[] }>('/users?pageSize=200')
      .then((r) => setPeople(r.rows))
      .catch(() => {});
  }, []);

  const open = stages.filter((s) => !['WON', 'LOST'].includes(s.key));
  const openValue = open.reduce((sum, s) => sum + s.value, 0);
  const openWeighted = open.reduce((sum, s) => sum + s.weighted, 0);
  const won = stages.find((s) => s.key === 'WON');

  if (loading) return <Loading />;

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Sales Pipeline</h1>
          <p>
            Leads and quotations in one view, by stage. Weighted value is amount × probability — the
            number that answers what you can actually expect to land, rather than the sum of every
            hopeful quotation.
          </p>
        </div>
        <select style={{ width: 'auto' }} value={owner} onChange={(e) => setOwner(e.target.value)}>
          <option value="">All salespeople</option>
          {people.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </div>

      <ErrorBox error={error} />

      <div className="grid grid-3" style={{ marginBottom: 18 }}>
        <div className="card">
          <div className="faint" style={{ fontSize: 11, letterSpacing: 1 }}>
            OPEN PIPELINE
          </div>
          <div style={{ fontSize: 20, marginTop: 6, fontWeight: 600 }}>{formatMoney(openValue)}</div>
        </div>
        <div className="card">
          <div className="faint" style={{ fontSize: 11, letterSpacing: 1 }}>
            WEIGHTED
          </div>
          <div style={{ fontSize: 20, marginTop: 6, fontWeight: 600, color: 'var(--neon)' }}>
            {formatMoney(openWeighted)}
          </div>
        </div>
        <div className="card">
          <div className="faint" style={{ fontSize: 11, letterSpacing: 1 }}>
            WON
          </div>
          <div style={{ fontSize: 20, marginTop: 6, fontWeight: 600 }}>
            {formatMoney(won?.value ?? 0)}
            <span className="faint" style={{ fontSize: 13, marginLeft: 8 }}>
              {won?.count ?? 0} job{won?.count === 1 ? '' : 's'}
            </span>
          </div>
        </div>
      </div>

      {stages.every((s) => s.count === 0) ? (
        <div className="card">
          <Empty title="Nothing in the pipeline yet" hint="Add a lead, and it appears here." />
        </div>
      ) : (
        <div className="pipeline">
          {stages.map((stage) => (
            <div key={stage.key} className="pipe-col">
              <div className="pipe-head">
                <strong>{stage.label}</strong>
                <span className="badge">{stage.count}</span>
              </div>
              <div className="pipe-total mono">{formatMoney(stage.value)}</div>
              {stage.weighted !== stage.value && (
                <div className="pipe-total faint mono" style={{ fontSize: 11 }}>
                  {formatMoney(stage.weighted)} weighted
                </div>
              )}
              <div className="pipe-body">
                {stage.cards.map((c) => (
                  <Link key={`${c.kind}-${c.id}`} to={c.link} className="pipe-card">
                    <div className="row" style={{ justifyContent: 'space-between', gap: 6 }}>
                      <span style={{ fontSize: 13 }}>{c.title}</span>
                      <span className={`tag ${c.kind === 'quotation' ? '' : ''}`}>
                        {c.kind === 'quotation' ? 'QT' : 'LEAD'}
                      </span>
                    </div>
                    <div className="faint" style={{ fontSize: 11, margin: '3px 0' }}>
                      {c.subtitle}
                    </div>
                    <div className="row" style={{ justifyContent: 'space-between' }}>
                      <span className="mono" style={{ fontSize: 12 }}>
                        {formatMoney(c.amount)}
                      </span>
                      <span className="section-label">
                        {c.probability}%
                      </span>
                    </div>
                    {c.owner && (
                      <div className="faint" style={{ fontSize: 10, marginTop: 3 }}>
                        {c.owner.name}
                      </div>
                    )}
                  </Link>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
