import { useCallback, useEffect, useState } from 'react';
import { api, qs } from '../lib/api';
import { todayLocal } from '../lib/day';
import { Empty, ErrorBox, Field, Loading, formatDateTime, useToast } from './ui';
import { Icon, type IconName } from './Icon';

/**
 * What anyone has actually done about this record, and what happens next.
 *
 * A status tells you where something got to; it never tells you who rang on
 * Tuesday or what they were told. That is the part a salesperson carries in
 * their head and loses when they hand the lead over, so it is the part worth
 * writing down.
 *
 * Built on SalesActivity, which already existed and already pointed at a
 * lead, a quotation and a customer — the calendar was reading it a fortnight
 * at a time and nothing was reading a record's whole history.
 *
 * An entry is either done or planned. Done is what happened; planned is the
 * next action, which is the same thing seen from the other end — so both live
 * in one list rather than in a log and a separate reminder that disagree.
 */

/**
 * The built-in types' icons, by key. The types themselves are data (Admin ›
 * Categories › Activity types, 2026-10-08) and come from the API; a type
 * added there gets the plain icon.
 */
const TYPE_ICONS: Record<string, IconName> = {
  CALL: 'people',
  SITE_VISIT: 'truck',
  MEETING: 'people',
  FOLLOW_UP: 'clock',
  SUBMISSION: 'document',
  OTHER: 'panel',
};
const BUILTIN_TYPES: { value: string; label: string }[] = [
  { value: 'CALL', label: 'Call' },
  { value: 'SITE_VISIT', label: 'Site visit' },
  { value: 'MEETING', label: 'Meeting' },
  { value: 'FOLLOW_UP', label: 'Follow-up' },
  { value: 'SUBMISSION', label: 'Submission' },
  { value: 'OTHER', label: 'Other' },
];

interface Activity {
  id: string;
  type: string;
  /** The type's name as Admin › Categories has it. */
  typeName?: string;
  status: string;
  subject: string;
  notes: string | null;
  location: string | null;
  startsAt: string;
  completedAt: string | null;
  assignedTo: { id: string; name: string } | null;
}

const iconOf = (key: string): IconName => TYPE_ICONS[key] ?? 'panel';

/** The time now, to the quarter hour, as an `<input type="time">` value. */
function nowTime(): string {
  const d = new Date();
  const minutes = Math.floor(d.getMinutes() / 15) * 15;
  return `${String(d.getHours()).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}

const blankForm = () => ({
  type: 'CALL',
  subject: '',
  notes: '',
  when: todayLocal(),
  time: nowTime(),
  done: true,
});

export function ActivityLog({
  leadId,
  quotationId,
  customerId,
  canEdit = true,
}: {
  leadId?: string;
  quotationId?: string;
  customerId?: string;
  canEdit?: boolean;
}) {
  const toast = useToast();
  const [rows, setRows] = useState<Activity[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState(blankForm);
  const [types, setTypes] = useState<{ value: string; label: string }[]>(BUILTIN_TYPES);

  // The types on offer, as data; the built-ins stand in until they load.
  useEffect(() => {
    api
      .get<{ key: string; name: string }[]>('/reference/activity-types?active=true')
      .then((rows) => {
        if (rows.length) setTypes(rows.map((t) => ({ value: t.key, label: t.name })));
      })
      .catch(() => {});
  }, []);

  const load = useCallback(() => {
    api
      .get<Activity[]>(`/activities${qs({ leadId, quotationId, customerId })}`)
      .then(setRows)
      .catch(setError);
  }, [leadId, quotationId, customerId]);

  useEffect(load, [load]);

  async function add(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.post('/activities', {
        type: form.type,
        subject: form.subject,
        notes: form.notes || null,
        leadId: leadId ?? null,
        quotationId: quotationId ?? null,
        customerId: customerId ?? null,
        // The instant the person meant, in THEIR clock, sent as UTC. A bare
        // `T12:00:00` put every planned site visit at noon, and a local string
        // with no offset is read in whatever zone the server happens to run.
        startsAt: new Date(`${form.when}T${form.time || '09:00'}`).toISOString(),
        status: form.done ? 'DONE' : 'PLANNED',
      });
      toast('ok', form.done ? 'Logged' : 'Next action set');
      setForm(blankForm());
      setOpen(false);
      load();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  /** Marking a planned action done is the commonest edit, so it is one click. */
  async function complete(row: Activity) {
    setBusy(true);
    try {
      await api.patch(`/activities/${row.id}`, { status: 'DONE' });
      load();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  const planned = rows?.filter((r) => r.status === 'PLANNED') ?? [];
  const history = rows?.filter((r) => r.status !== 'PLANNED') ?? [];

  return (
    <section className="card">
      <div className="panel-head">
        <h3 className="card-title">
          Activity
          {rows?.length ? <span className="badge">{rows.length}</span> : null}
        </h3>
        {canEdit && (
          <button className="btn btn-sm btn-primary" onClick={() => setOpen((o) => !o)}>
            {open ? 'Cancel' : 'Log activity'}
          </button>
        )}
      </div>
      <p className="panel-blurb">
        What has been done about this, and what happens next. Write it as you go — this is what
        somebody else needs when the work changes hands.
      </p>

      <ErrorBox error={error} />

      {open && canEdit && (
        <form className="activity-form" onSubmit={add}>
          <div className="grid grid-2">
            <Field label="What happened">
              <select value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })}>
                {types.map((t) => (
                  <option key={t.value} value={t.value}>
                    {t.label}
                  </option>
                ))}
              </select>
            </Field>
            <div className="grid grid-2">
              <Field label="When">
                <input
                  type="date"
                  value={form.when}
                  onChange={(e) => setForm({ ...form, when: e.target.value })}
                />
              </Field>
              <Field label="At">
                <input
                  type="time"
                  step={900}
                  value={form.time}
                  onChange={(e) => setForm({ ...form, time: e.target.value })}
                />
              </Field>
            </div>
          </div>

          <Field label="In a line" hint="Spoke to whom, about what, what came of it">
            <input
              value={form.subject}
              onChange={(e) => setForm({ ...form, subject: e.target.value })}
              required
            />
          </Field>

          <Field label="Anything else" hint="Optional — the detail worth keeping">
            <textarea
              rows={3}
              value={form.notes}
              onChange={(e) => setForm({ ...form, notes: e.target.value })}
            />
          </Field>

          <div className="row" style={{ gap: 'var(--s-3)', alignItems: 'center' }}>
            <label className="activity-toggle">
              <input
                type="checkbox"
                checked={!form.done}
                onChange={(e) => setForm({ ...form, done: !e.target.checked })}
              />
              This is the next action, not something already done
            </label>
            <button className="btn btn-primary btn-sm" type="submit" disabled={busy}>
              {busy ? 'Saving…' : 'Save'}
            </button>
          </div>
        </form>
      )}

      {rows === null ? (
        <Loading label="Reading the history…" />
      ) : rows.length === 0 ? (
        <Empty
          title="Nothing logged yet"
          hint={canEdit ? 'Record the first call or visit and it stays with the record.' : undefined}
        />
      ) : (
        <>
          {planned.length > 0 && (
            <>
              <div className="section-label">NEXT</div>
              <ul className="activity-list">
                {planned.map((row) => (
                  <li key={row.id} className="activity-row planned">
                    <Icon name={iconOf(row.type)} size={16} />
                    <div className="activity-body">
                      <strong>{row.subject}</strong>
                      {row.notes && <span className="activity-notes">{row.notes}</span>}
                      <span className="activity-meta">
                        {row.typeName ?? row.type} · due {formatDateTime(row.startsAt)} ·{' '}
                        {row.assignedTo?.name ?? 'unassigned'}
                      </span>
                    </div>
                    {canEdit && (
                      <button className="btn btn-sm" onClick={() => complete(row)} disabled={busy}>
                        Done
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            </>
          )}

          {history.length > 0 && (
            <>
              <div className="section-label">WHAT HAS HAPPENED</div>
              <ul className="activity-list">
                {history.map((row) => (
                  <li key={row.id} className={`activity-row${row.status === 'CANCELLED' ? ' off' : ''}`}>
                    <Icon name={iconOf(row.type)} size={16} />
                    <div className="activity-body">
                      <strong>{row.subject}</strong>
                      {row.notes && <span className="activity-notes">{row.notes}</span>}
                      <span className="activity-meta">
                        {row.typeName ?? row.type} · {formatDateTime(row.startsAt)} ·{' '}
                        {row.assignedTo?.name ?? 'unassigned'}
                      </span>
                    </div>
                  </li>
                ))}
              </ul>
            </>
          )}
        </>
      )}
    </section>
  );
}
