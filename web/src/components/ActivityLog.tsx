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

const TYPES: { value: string; label: string; icon: IconName }[] = [
  { value: 'CALL', label: 'Call', icon: 'people' },
  { value: 'SITE_VISIT', label: 'Site visit', icon: 'truck' },
  { value: 'MEETING', label: 'Meeting', icon: 'people' },
  { value: 'FOLLOW_UP', label: 'Follow-up', icon: 'clock' },
  { value: 'SUBMISSION', label: 'Submission', icon: 'document' },
  { value: 'OTHER', label: 'Other', icon: 'panel' },
];

interface Activity {
  id: string;
  type: string;
  status: string;
  subject: string;
  notes: string | null;
  location: string | null;
  startsAt: string;
  completedAt: string | null;
  assignedTo: { id: string; name: string } | null;
}

const typeOf = (v: string) => TYPES.find((t) => t.value === v) ?? TYPES[5];

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
  const [form, setForm] = useState({
    type: 'CALL',
    subject: '',
    notes: '',
    when: todayLocal(),
    done: true,
  });

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
        // Midday, so a date with no time cannot land on the wrong side of a
        // timezone boundary and read as the day before.
        startsAt: `${form.when}T12:00:00`,
        status: form.done ? 'DONE' : 'PLANNED',
      });
      toast('ok', form.done ? 'Logged' : 'Next action set');
      setForm({ type: 'CALL', subject: '', notes: '', when: todayLocal(), done: true });
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
        somebody else needs when the lead changes hands.
      </p>

      <ErrorBox error={error} />

      {open && canEdit && (
        <form className="activity-form" onSubmit={add}>
          <div className="grid grid-2">
            <Field label="What happened">
              <select value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })}>
                {TYPES.map((t) => (
                  <option key={t.value} value={t.value}>
                    {t.label}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="When">
              <input
                type="date"
                value={form.when}
                onChange={(e) => setForm({ ...form, when: e.target.value })}
              />
            </Field>
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
          hint={canEdit ? 'Record the first call or visit and it stays with the lead.' : undefined}
        />
      ) : (
        <>
          {planned.length > 0 && (
            <>
              <div className="section-label">NEXT</div>
              <ul className="activity-list">
                {planned.map((row) => (
                  <li key={row.id} className="activity-row planned">
                    <Icon name={typeOf(row.type).icon} size={16} />
                    <div className="activity-body">
                      <strong>{row.subject}</strong>
                      {row.notes && <span className="activity-notes">{row.notes}</span>}
                      <span className="activity-meta">
                        {typeOf(row.type).label} · due {formatDateTime(row.startsAt)} ·{' '}
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
                    <Icon name={typeOf(row.type).icon} size={16} />
                    <div className="activity-body">
                      <strong>{row.subject}</strong>
                      {row.notes && <span className="activity-notes">{row.notes}</span>}
                      <span className="activity-meta">
                        {typeOf(row.type).label} · {formatDateTime(row.startsAt)} ·{' '}
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
