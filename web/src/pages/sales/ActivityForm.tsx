import { useEffect, useRef, useState, type FocusEvent } from 'react';
import { api, qs } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { dayKeyOf } from '../../lib/day';
import { Checkbox, ErrorBox, Field, Modal, formatDateTime } from '../../components/ui';
import { NumberInput } from '../../components/NumberInput';
import { PeoplePicker } from '../../components/PeoplePicker';
import { CustomerPicker, type CustomerRef } from '../../components/CustomerPicker';
import { REMINDERS, REPEATS, type Activity, type ActivityTypeDef, type Person } from './activityShared';

// ════════════════════════════════════════════════════════════════════
//  THE ACTIVITY FORM  (2026-10-08, SCORO's "New event" dialog)
// ════════════════════════════════════════════════════════════════════

/*
  The owner's first screenshot, SCORO's New event dialog, is the reference:
  the event on the left — Date, Start, Duration in hours and minutes with
  the end shown, All day, Repeat, Title, Activity type, Address, Private,
  Conference call link, Description, Reminder — and, beside it, the
  Participants (find users, tick them, select all) and the Links: customer,
  contact person, project, quotation, lead. Save, Save and open, Save and
  add another across the foot. SCORO's Busy, Shared resources and rich text
  are not here: G-CORE has no resource booking and no availability view,
  and the description is plain text as every note in the app is.

  The links are offered here again (they were taken off the calendar's form
  on 2026-10-07): SCORO's dialog has them, and the owner asked for SCORO's
  dialog. Each is offered only to someone who may read that record.
*/

export type SaveAction = 'close' | 'open' | 'another';

/** A picked record: what the lookup returned, named for the chip. */
interface LookupRef {
  id: string;
  label: string;
  sub?: string;
}

interface ContactRow {
  id: string;
  name: string;
  position: string | null;
}

/** "HH:MM" of a local instant, for a time input. */
function timeInput(d: Date): string {
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** The instant a date and a time name, in the person's own clock. */
function localInstant(date: string, time: string): Date {
  return new Date(`${date}T${time || '00:00'}`);
}

interface FormState {
  type: string;
  subject: string;
  date: string;
  startTime: string;
  hours: number;
  minutes: number;
  /** For an all-day booking: how many whole days. */
  days: number;
  allDay: boolean;
  repeatEvery: string;
  repeatUntil: string;
  location: string;
  isPrivate: boolean;
  callLink: string;
  notes: string;
  reminderMinutes: string;
  assignedToId: string;
  inviteeIds: string[];
  customer: CustomerRef | null;
  contactId: string;
  job: LookupRef | null;
  quotation: LookupRef | null;
  lead: LookupRef | null;
  status: string;
}

function initialForm(activity: Activity | null, defaultStart: Date, meId: string, defaultType: string): FormState {
  const start = activity ? new Date(activity.startsAt) : defaultStart;
  const minutes = activity?.durationMinutes ?? 60;
  return {
    type: activity?.type ?? defaultType,
    subject: activity?.subject ?? '',
    date: dayKeyOf(start),
    startTime: timeInput(start),
    hours: Math.floor((activity?.allDay ? 60 : minutes) / 60),
    minutes: activity?.allDay ? 0 : minutes % 60,
    days: activity?.allDay ? Math.max(1, Math.round(minutes / 1440)) : 1,
    allDay: activity?.allDay ?? false,
    repeatEvery: '',
    repeatUntil: '',
    location: activity?.location ?? '',
    isPrivate: activity?.isPrivate ?? false,
    callLink: activity?.callLink ?? '',
    notes: activity?.notes ?? '',
    reminderMinutes: activity?.reminderMinutes != null ? String(activity.reminderMinutes) : '',
    assignedToId: activity?.assignedTo.id ?? meId,
    inviteeIds: activity?.invitees.map((i) => i.userId) ?? [],
    customer: activity?.customer ? { id: activity.customer.id, name: activity.customer.name } : null,
    contactId: activity?.contact?.id ?? '',
    job: activity?.job ? { id: activity.job.id, label: `${activity.job.number} — ${activity.job.name}` } : null,
    quotation: activity?.quotation ? { id: activity.quotation.id, label: activity.quotation.number } : null,
    lead: activity?.lead ? { id: activity.lead.id, label: `${activity.lead.number} — ${activity.lead.companyName}` } : null,
    status: activity?.status ?? 'PLANNED',
  };
}

/** The activity form — "+ Schedule" on the calendar, Modify on the activity's page. */
export function ActivityModal({
  activity,
  people,
  types,
  defaultStart,
  onClose,
  onSaved,
  onRemoved,
}: {
  activity: Activity | null;
  people: Person[];
  /** The types on file; the form offers the active ones, plus the one the activity already has. */
  types: ActivityTypeDef[];
  defaultStart: Date;
  onClose: () => void;
  /** After Save ('close'), Save and open ('open' — the caller opens the page) or Save and add another ('another' — the form stays, blank). */
  onSaved: (saved: Activity, action: SaveAction) => void;
  /** After Remove; the activity's page leaves for the calendar. Defaults to closing through `onSaved`'s caller. */
  onRemoved?: (removed: number) => void;
}) {
  const { me, can } = useAuth();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const typeOptions = types.filter((t) => t.isActive || t.key === activity?.type);
  const defaultType = typeOptions.some((t) => t.key === 'FOLLOW_UP') ? 'FOLLOW_UP' : (typeOptions[0]?.key ?? 'OTHER');
  const [form, setForm] = useState<FormState>(() => initialForm(activity, defaultStart, me?.user.id ?? '', defaultType));
  const set = <K extends keyof FormState>(key: K, value: FormState[K]) => setForm((f) => ({ ...f, [key]: value }));

  // ── When ──
  const startsAt = form.allDay ? localInstant(form.date, '00:00') : localInstant(form.date, form.startTime);
  const durationMinutes = form.allDay ? Math.max(1, form.days) * 1440 : form.hours * 60 + form.minutes;
  const endsAt = new Date(startsAt.getTime() + durationMinutes * 60_000);
  const validWhen = !!form.date && (form.allDay || !!form.startTime) && Number.isFinite(startsAt.getTime()) && durationMinutes >= 5;
  const endsText = !validWhen
    ? null
    : form.allDay
      ? form.days > 1
        ? `Through ${new Date(endsAt.getTime() - 1).toLocaleDateString('en-PH', { weekday: 'short', month: 'short', day: 'numeric' })}`
        : 'All day'
      : dayKeyOf(endsAt) === form.date
        ? `Ends ${endsAt.toLocaleTimeString('en-PH', { hour: '2-digit', minute: '2-digit' })}`
        : `Ends ${formatDateTime(endsAt)}`;
  const repeatBad = !!form.repeatEvery && (!form.repeatUntil || form.repeatUntil < form.date);
  const callLinkBad = !!form.callLink.trim() && !/^https?:\/\//i.test(form.callLink.trim());

  // ── Who may be booked, who may be invited ──
  // Someone who has since lost calendar access is still who it was booked for.
  const peopleOptions = activity && !people.some((p) => p.id === activity.assignedTo.id) ? [activity.assignedTo, ...people] : people;
  // Invited people who have since lost calendar access stay on the list.
  const inviteOptions = [
    ...peopleOptions,
    ...(activity?.invitees ?? []).map((i) => i.user).filter((u) => !peopleOptions.some((p) => p.id === u.id)),
  ];

  // ── Links: each offered only to someone who may read that record ──
  const mayCustomers = can('gops.customers.view_all');
  const mayProjects = can('gops.projects.view_all') || can('gops.projects.view_own');
  const mayQuotations = can('gops.quotations.view_all') || can('gops.quotations.view_own');
  const mayLeads = can('gops.leads.view_all') || can('gops.leads.view_own');
  const [contacts, setContacts] = useState<ContactRow[]>([]);
  useEffect(() => {
    if (!form.customer || !mayCustomers) {
      setContacts([]);
      return;
    }
    let cancelled = false;
    api
      .get<{ contacts: ContactRow[] }>(`/customers/${form.customer.id}`)
      .then((c) => {
        if (!cancelled) setContacts(c.contacts);
      })
      .catch(() => {
        if (!cancelled) setContacts([]);
      });
    return () => {
      cancelled = true;
    };
  }, [form.customer, mayCustomers]);

  const canSave = form.subject.trim().length >= 2 && validWhen && !repeatBad && !callLinkBad && !!form.assignedToId;

  function payload() {
    return {
      type: form.type,
      subject: form.subject.trim(),
      location: form.location.trim() || null,
      notes: form.notes || null,
      assignedToId: form.assignedToId,
      leadId: form.lead?.id ?? null,
      quotationId: form.quotation?.id ?? null,
      customerId: form.customer?.id ?? null,
      contactId: form.customer ? form.contactId || null : null,
      jobId: form.job?.id ?? null,
      startsAt: startsAt.toISOString(),
      endsAt: endsAt.toISOString(),
      allDay: form.allDay,
      isPrivate: form.isPrivate,
      callLink: form.callLink.trim() || null,
      reminderMinutes: form.reminderMinutes ? Number(form.reminderMinutes) : null,
      inviteeIds: form.inviteeIds.filter((id) => id !== form.assignedToId),
      status: form.status,
      ...(!activity && form.repeatEvery ? { repeat: { every: form.repeatEvery, until: form.repeatUntil } } : {}),
    };
  }

  async function save(action: SaveAction) {
    setBusy(true);
    setError(null);
    try {
      const saved = activity
        ? await api.patch<Activity>(`/activities/${activity.id}`, payload())
        : await api.post<Activity>('/activities', payload());
      if (action === 'another') {
        // The same day and time, blank — the next thing to book is usually beside this one.
        setForm((f) => ({
          ...initialForm(null, startsAt, me?.user.id ?? '', defaultType),
          assignedToId: f.assignedToId,
          allDay: f.allDay,
          days: f.days,
          hours: f.hours,
          minutes: f.minutes,
        }));
        setBusy(false);
      }
      onSaved(saved, action);
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  }

  async function remove(series: boolean) {
    if (!activity) return;
    setBusy(true);
    setError(null);
    try {
      const out = await api.del<{ removed: number }>(`/activities/${activity.id}${series ? '?series=upcoming' : ''}`);
      if (onRemoved) onRemoved(out?.removed ?? 1);
      else onSaved(activity, 'close');
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  }

  const removing = activity && confirmRemove;

  return (
    <Modal
      title={activity ? 'Modify activity' : 'New activity'}
      onClose={onClose}
      wide
      footer={
        <>
          {activity &&
            (removing ? (
              <>
                <span className="act-confirm">Remove it? Everyone on it loses it from their calendar.</span>
                <button type="button" className="btn btn-danger" onClick={() => remove(false)} disabled={busy}>
                  {activity.seriesId ? 'Remove this one' : 'Yes, remove it'}
                </button>
                {activity.seriesId && (
                  <button type="button" className="btn btn-danger" onClick={() => remove(true)} disabled={busy}>
                    Remove this and later ones
                  </button>
                )}
                <button type="button" className="btn" onClick={() => setConfirmRemove(false)} disabled={busy}>
                  Keep it
                </button>
              </>
            ) : (
              <button type="button" className="btn btn-danger" onClick={() => setConfirmRemove(true)} disabled={busy}>
                Remove
              </button>
            ))}
          <div className="topbar-spacer" />
          <button type="button" className="btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          {!activity && (
            <button type="button" className="btn" onClick={() => save('another')} disabled={busy || !canSave}>
              Save and add another
            </button>
          )}
          <button type="button" className="btn" onClick={() => save('open')} disabled={busy || !canSave}>
            Save and open
          </button>
          <button type="button" className="btn btn-primary" onClick={() => save('close')} disabled={busy || !canSave}>
            {busy ? 'Saving…' : 'Save'}
          </button>
        </>
      }
    >
      <ErrorBox error={error} />

      <div className="act-form">
        <div className="act-form-main">
          <div className="act-when-row">
            <Field label="Date" required>
              <input type="date" value={form.date} onChange={(e) => set('date', e.target.value)} />
            </Field>
            {!form.allDay && (
              <Field label="Start" required>
                <input type="time" step={300} value={form.startTime} onChange={(e) => set('startTime', e.target.value)} />
              </Field>
            )}
            {form.allDay ? (
              <Field label="Days">
                <div className="act-duration">
                  <NumberInput kind="count" min={1} max={30} value={form.days} onChange={(e) => set('days', Number(e.target.value) || 1)} aria-label="Days" />
                  <span className="faint">day{form.days === 1 ? '' : 's'}</span>
                </div>
              </Field>
            ) : (
              <Field label="Duration">
                <div className="act-duration">
                  <NumberInput kind="count" min={0} max={168} value={form.hours} onChange={(e) => set('hours', Number(e.target.value) || 0)} aria-label="Hours" />
                  <span className="faint">h</span>
                  <NumberInput kind="count" min={0} max={59} step={5} value={form.minutes} onChange={(e) => set('minutes', Number(e.target.value) || 0)} aria-label="Minutes" />
                  <span className="faint">min</span>
                </div>
              </Field>
            )}
          </div>
          <p className="act-ends" aria-live="polite">
            {endsText ?? (durationMinutes < 5 && validWhen === false ? 'At least 5 minutes' : 'Pick the date and time')}
          </p>
          <div className="act-toggles">
            <Checkbox checked={form.allDay} onChange={(v) => set('allDay', v)} label="All day" />
            <Checkbox checked={form.isPrivate} onChange={(v) => set('isPrivate', v)} label="Private — others see only “Busy”" />
          </div>
          {!activity && (
            <div className="act-repeat">
              <Field label="Repeat">
                <select value={form.repeatEvery} onChange={(e) => set('repeatEvery', e.target.value)}>
                  {REPEATS.map((r) => (
                    <option key={r.value} value={r.value}>
                      {r.label}
                    </option>
                  ))}
                </select>
              </Field>
              {form.repeatEvery && (
                <Field label="Until" required error={repeatBad && form.repeatUntil ? 'On or after the first day' : null}>
                  <input type="date" value={form.repeatUntil} min={form.date} onChange={(e) => set('repeatUntil', e.target.value)} />
                </Field>
              )}
            </div>
          )}

          <Field label="Title" required>
            <input value={form.subject} autoFocus onChange={(e) => set('subject', e.target.value)} />
          </Field>

          <div className="grid grid-2">
            <Field label="Activity type">
              <select value={form.type} onChange={(e) => set('type', e.target.value)}>
                {typeOptions.map((t) => (
                  <option key={t.key} value={t.key}>
                    {t.name}
                    {!t.isActive ? ' (no longer offered)' : ''}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Booked for">
              <select value={form.assignedToId} onChange={(e) => set('assignedToId', e.target.value)}>
                {peopleOptions.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </Field>
          </div>

          <Field label="Address">
            <input value={form.location} onChange={(e) => set('location', e.target.value)} placeholder="Where it happens" />
          </Field>
          <Field label="Conference call link" error={callLinkBad ? 'Starts with http:// or https://' : null}>
            <input value={form.callLink} onChange={(e) => set('callLink', e.target.value)} placeholder="https://meet.google.com/…" inputMode="url" />
          </Field>
          <Field label="Description">
            <textarea value={form.notes} onChange={(e) => set('notes', e.target.value)} rows={4} />
          </Field>
          <div className="grid grid-2">
            <Field label="Reminder" hint="A notification — and an email where email is set up — to everyone on it">
              <select value={form.reminderMinutes} onChange={(e) => set('reminderMinutes', e.target.value)}>
                {REMINDERS.map((r) => (
                  <option key={r.value} value={r.value}>
                    {r.label}
                  </option>
                ))}
              </select>
            </Field>
            {activity && (
              <Field label="Status">
                <select value={form.status} onChange={(e) => set('status', e.target.value)}>
                  <option value="PLANNED">Planned</option>
                  <option value="DONE">Done</option>
                  <option value="CANCELLED">Cancelled</option>
                </select>
              </Field>
            )}
          </div>
        </div>

        <aside className="act-form-side">
          <section>
            <h4>Participants</h4>
            <p className="faint act-side-note">They are told when you save, and it shows on their calendar and in My Work.</p>
            <PeoplePicker
              people={inviteOptions.map((p) => ({ id: p.id, name: p.name, photoId: p.photoPath ?? null }))}
              value={form.inviteeIds}
              onChange={(ids) => set('inviteeIds', ids)}
              exclude={[form.assignedToId]}
            />
          </section>

          <section>
            <h4>Links</h4>
            {mayCustomers ? (
              <>
                <Field label="Customer">
                  <CustomerPicker
                    value={form.customer}
                    onChange={(c) => setForm((f) => ({ ...f, customer: c, contactId: c && c.id === f.customer?.id ? f.contactId : '' }))}
                    onError={setError}
                  />
                </Field>
                <Field label="Contact person">
                  <select value={form.contactId} disabled={!form.customer} onChange={(e) => set('contactId', e.target.value)}>
                    <option value="">{form.customer ? (contacts.length ? '— none —' : 'No contacts on file') : 'Pick the customer first'}</option>
                    {contacts.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                        {c.position ? ` · ${c.position}` : ''}
                      </option>
                    ))}
                  </select>
                </Field>
              </>
            ) : (
              (activity?.customer || activity?.contact) && (
                <p className="faint act-side-note">
                  Linked to {activity.customer?.name}
                  {activity.contact ? ` · ${activity.contact.name}` : ''} (kept)
                </p>
              )
            )}
            {mayProjects ? (
              <Field label="Project">
                <LookupPicker
                  placeholder="Number or name"
                  value={form.job}
                  onChange={(v) => set('job', v)}
                  search={async (q) =>
                    (await api.get<{ id: string; number: string; name: string }[]>(`/jobs/lookup${qs({ q, includeClosed: 'true' })}`))
                      .slice(0, 8)
                      .map((j) => ({ id: j.id, label: `${j.number} — ${j.name}` }))
                  }
                />
              </Field>
            ) : (
              activity?.job && <p className="faint act-side-note">Project {activity.job.number} (kept)</p>
            )}
            {mayQuotations ? (
              <Field label="Quotation">
                <LookupPicker
                  placeholder="Number, name or customer"
                  value={form.quotation}
                  onChange={(v) => set('quotation', v)}
                  search={async (q) =>
                    (
                      await api.get<{ rows: { id: string; number: string; subject: string; customer: { name: string } }[] }>(
                        `/quotations${qs({ search: q, pageSize: 8 })}`,
                      )
                    ).rows.map((r) => ({ id: r.id, label: `${r.number} — ${r.subject}`, sub: r.customer?.name }))
                  }
                />
              </Field>
            ) : (
              activity?.quotation && <p className="faint act-side-note">Quotation {activity.quotation.number} (kept)</p>
            )}
            {mayLeads ? (
              <Field label="Lead">
                <LookupPicker
                  placeholder="Number or company"
                  value={form.lead}
                  onChange={(v) => set('lead', v)}
                  search={async (q) =>
                    (await api.get<{ rows: { id: string; number: string; companyName: string }[] }>(`/leads${qs({ search: q, pageSize: 8 })}`)).rows.map(
                      (r) => ({ id: r.id, label: `${r.number} — ${r.companyName}` }),
                    )
                  }
                />
              </Field>
            ) : (
              activity?.lead && <p className="faint act-side-note">Lead {activity.lead.number} (kept)</p>
            )}
          </section>
        </aside>
      </div>
    </Modal>
  );
}

/**
 * Type, pick one of the matches, or clear what was picked — the customer
 * picker's manners (debounced search as you type, the matches as buttons,
 * Escape closes, focus leaving closes) for any record the links name.
 */
function LookupPicker({
  value,
  onChange,
  search,
  placeholder,
}: {
  value: LookupRef | null;
  onChange: (v: LookupRef | null) => void;
  search: (q: string) => Promise<LookupRef[]>;
  placeholder?: string;
}) {
  const [text, setText] = useState('');
  const [picking, setPicking] = useState(false);
  const [matches, setMatches] = useState<LookupRef[]>([]);
  const menuRef = useRef<HTMLUListElement>(null);

  useEffect(() => {
    const term = text.trim();
    if (!picking || term.length < 2) {
      setMatches([]);
      return;
    }
    let cancelled = false;
    const t = setTimeout(() => {
      search(term)
        .then((rows) => {
          if (!cancelled) setMatches(rows);
        })
        .catch(() => {
          if (!cancelled) setMatches([]);
        });
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
    // `search` is a fresh closure each render; the term is what changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text, picking]);

  function onBlur(e: FocusEvent<HTMLDivElement>) {
    if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setPicking(false);
  }

  if (value) {
    return (
      <div className="lookup-picked">
        <span>
          {value.label}
          {value.sub && <span className="faint"> · {value.sub}</span>}
        </span>
        <button type="button" className="chip-remove" aria-label={`Clear ${value.label}`} onClick={() => onChange(null)}>
          ×
        </button>
      </div>
    );
  }
  const open = picking && text.trim().length >= 2;
  return (
    <div
      className="lookup"
      onBlur={onBlur}
      onKeyDown={(e) => {
        if (e.key === 'Escape' && picking) setPicking(false);
        if (e.key === 'ArrowDown' && picking) {
          const first = menuRef.current?.querySelector<HTMLElement>('button');
          if (first) {
            e.preventDefault();
            first.focus();
          }
        }
      }}
    >
      <input
        value={text}
        autoComplete="off"
        placeholder={placeholder}
        aria-expanded={open}
        aria-autocomplete="list"
        onFocus={() => setPicking(true)}
        onChange={(e) => {
          setText(e.target.value);
          setPicking(true);
        }}
      />
      {open && (
        <ul className="lookup-menu" ref={menuRef}>
          {matches.length === 0 ? (
            <li className="lookup-new">
              <div className="lookup-new-row faint">Nothing matches</div>
            </li>
          ) : (
            matches.map((m) => (
              <li key={m.id}>
                <button
                  type="button"
                  onClick={() => {
                    onChange(m);
                    setText('');
                    setPicking(false);
                  }}
                >
                  {m.label}
                  {m.sub && <span className="faint"> · {m.sub}</span>}
                </button>
              </li>
            ))
          )}
        </ul>
      )}
    </div>
  );
}
