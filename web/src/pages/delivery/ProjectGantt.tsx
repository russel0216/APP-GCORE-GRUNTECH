import { useId, useMemo, useState } from 'react';
import { api } from '../../lib/api';
import { addDays, daysBetween, mondayOf, parseDay, todayLocal } from '../../lib/day';
import { Empty, ErrorBox, Field, ModalFoot, StatusBadge, formatDate, useToast } from '../../components/ui';
import { NumberInput } from '../../components/NumberInput';
import { PersonSelect, usePeople } from '../../components/People';

/**
 * The Scope of Work as a Gantt chart (2026-10-06) — the old gasiontech
 * G-CORE's planner, on this project's data: every scope line (a phase) with
 * its planned span, and under it the tasks that make it up, each a bar from
 * its start to its due date filled to its percent complete.
 *
 * Nothing here is a second store. A phase's dates are the scope line's
 * `plannedStart`/`plannedEnd` (which the planned S-curve reads); a task is a
 * `JobTask`, edited through the same routes the Tasks card used. "Plan from
 * costing" asks the server to write the costing's working-day plan down as
 * dated tasks, once — see POST /jobs/:id/tasks/from-costing.
 */

export interface GanttScopeItem {
  id: string;
  name: string;
  plannedStart: string | null;
  plannedEnd: string | null;
  durationDays: number;
}

export interface GanttTask {
  id: string;
  name: string;
  status: string;
  progressPct: number;
  startDate: string | null;
  dueDate: string | null;
  scopeItemId: string | null;
  assignedTo: { id: string; name: string } | null;
}

const TASK_TONES = { DONE: 'ok', BLOCKED: 'danger', IN_PROGRESS: 'info', NOT_STARTED: '' } as const;
const STATUS_LABEL: Record<string, string> = {
  NOT_STARTED: 'Not started',
  IN_PROGRESS: 'In progress',
  BLOCKED: 'Blocked',
  DONE: 'Done',
};
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** A DATE from the API ('2026-01-05T00:00:00.000Z') as its day key. */
const keyOf = (iso: string | null | undefined): string | null => (iso ? iso.slice(0, 10) : null);

type Row =
  | { kind: 'phase'; item: GanttScopeItem; start: string | null; end: string | null; pct: number | null; tasks: number }
  | { kind: 'task'; task: GanttTask; start: string | null; end: string | null }
  | { kind: 'heading'; label: string };

export function ProjectGantt({
  jobId,
  jobStart,
  jobEnd,
  scopeItems,
  tasks,
  hasCosting,
  canEdit,
  onChanged,
}: {
  jobId: string;
  jobStart: string | null;
  jobEnd: string | null;
  scopeItems: GanttScopeItem[];
  tasks: GanttTask[];
  hasCosting: boolean;
  canEdit: boolean;
  onChanged: () => Promise<void>;
}) {
  const toast = useToast();
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<GanttTask | 'new' | null>(null);

  // Phases in order, each with its tasks; tasks on no phase at the end.
  const rows = useMemo<Row[]>(() => {
    const out: Row[] = [];
    const byItem = new Map<string | null, GanttTask[]>();
    for (const t of tasks) {
      const list = byItem.get(t.scopeItemId) ?? [];
      list.push(t);
      byItem.set(t.scopeItemId, list);
    }
    for (const item of scopeItems) {
      const own = byItem.get(item.id) ?? [];
      const starts = own.map((t) => keyOf(t.startDate)).filter((k): k is string => !!k);
      const ends = own.map((t) => keyOf(t.dueDate)).filter((k): k is string => !!k);
      const pct = own.length ? Math.round(own.reduce((s, t) => s + t.progressPct, 0) / own.length) : null;
      out.push({
        kind: 'phase',
        item,
        start: keyOf(item.plannedStart) ?? (starts.length ? starts.sort()[0] : null),
        end: keyOf(item.plannedEnd) ?? (ends.length ? ends.sort()[ends.length - 1] : null),
        pct,
        tasks: own.length,
      });
      for (const t of own) out.push({ kind: 'task', task: t, start: keyOf(t.startDate), end: keyOf(t.dueDate) ?? keyOf(t.startDate) });
    }
    const loose = byItem.get(null) ?? [];
    if (loose.length) {
      out.push({ kind: 'heading', label: 'Not under a scope line' });
      for (const t of loose) out.push({ kind: 'task', task: t, start: keyOf(t.startDate), end: keyOf(t.dueDate) ?? keyOf(t.startDate) });
    }
    return out;
  }, [scopeItems, tasks]);

  // The time axis: whole weeks from the Monday before the earliest date to
  // the Sunday after the latest, at least four weeks, so a short plan still
  // reads as a calendar rather than three lonely columns.
  const today = todayLocal();
  const axis = useMemo(() => {
    const keys: string[] = [today];
    if (jobStart) keys.push(keyOf(jobStart)!);
    if (jobEnd) keys.push(keyOf(jobEnd)!);
    for (const r of rows) {
      if (r.kind === 'heading') continue;
      if (r.start) keys.push(r.start);
      if (r.end) keys.push(r.end);
    }
    keys.sort();
    const from = mondayOf(keys[0]);
    let to = addDays(mondayOf(keys[keys.length - 1]), 6);
    if (daysBetween(from, to) < 27) to = addDays(from, 27);
    const days: { key: string; date: Date }[] = [];
    for (let k = from; k <= to; k = addDays(k, 1)) days.push({ key: k, date: parseDay(k) });
    const months: { label: string; span: number }[] = [];
    for (const d of days) {
      const label = `${MONTHS[d.date.getMonth()]} ${d.date.getFullYear()}`;
      const last = months[months.length - 1];
      if (last && last.label === label) last.span++;
      else months.push({ label, span: 1 });
    }
    return { from, to, days, months };
  }, [rows, jobStart, jobEnd, today]);

  const col = (key: string) => daysBetween(axis.from, key);
  const todayCol = today >= axis.from && today <= axis.to ? col(today) : null;

  async function planFromCosting() {
    setBusy(true);
    setError(null);
    try {
      const r = await api.post<{ created: number; skipped: number }>(`/jobs/${jobId}/tasks/from-costing`);
      toast(
        'ok',
        r.created
          ? `${r.created} task${r.created === 1 ? '' : 's'} planned from the costing${r.skipped ? ` — ${r.skipped} line${r.skipped === 1 ? '' : 's'} already planned, left alone` : ''}`
          : r.skipped
            ? 'Every costed line already has its tasks — nothing changed'
            : 'The costing has no tasks under its scope of work',
      );
      await onChanged();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  const wide = axis.days.length;

  function Bar({ start, end, pct, tone }: { start: string | null; end: string | null; pct: number | null; tone: string }) {
    if (!start) return null;
    const first = Math.max(0, col(start));
    const last = Math.min(wide - 1, col(end ?? start));
    if (last < first) return null;
    return (
      <div
        className={`gantt-bar tone-${tone}`}
        style={{ left: `calc(var(--gantt-cell) * ${first})`, width: `calc(var(--gantt-cell) * ${last - first + 1})` }}
        title={`${formatDate(start)} – ${formatDate(end ?? start)}${pct !== null ? ` · ${pct}%` : ''}`}
      >
        {pct !== null && pct > 0 && <div className="gantt-fill" style={{ width: `${Math.min(100, pct)}%` }} />}
      </div>
    );
  }

  return (
    <div className="card">
      <div className="del-card-head">
        <h3 className="card-title">Scope of work — Gantt chart</h3>
        {canEdit && (
          <div className="row">
            {hasCosting && (
              <button
                type="button"
                className="btn btn-sm"
                onClick={planFromCosting}
                disabled={busy || !jobStart}
                title={jobStart ? 'Write the costing’s working-day plan down as dated tasks, for scope lines with no tasks yet' : 'Give the project a start date first (Modify)'}
              >
                Plan from costing
              </button>
            )}
            <button type="button" className="btn btn-sm" onClick={() => setEditing('new')} disabled={busy}>
              + Add task
            </button>
          </div>
        )}
      </div>
      <p className="muted del-lede">
        Each scope line is a phase; its tasks sit under it. A bar runs from a task’s start to its due date and fills
        to its percent complete. Planned dates come from the costing’s scope of work, in working days from the start
        date; the planned S-curve reads the same dates.
      </p>
      <ErrorBox error={error} />

      {rows.length === 0 ? (
        <Empty title="No scope of work yet" hint="The project’s scope lines come from its costing." />
      ) : (
        <div className="gantt-wrap">
          <table className="gantt">
            <thead>
              <tr className="gantt-months">
                <th className="gantt-name" rowSpan={2}>
                  Activity
                </th>
                <th className="gantt-date" rowSpan={2}>
                  Start
                </th>
                <th className="gantt-date" rowSpan={2}>
                  Due
                </th>
                <th className="gantt-pct" rowSpan={2}>
                  %
                </th>
                <th className="gantt-time">
                  <div className="gantt-track">
                    {axis.months.map((m, i) => (
                      <div key={i} className="gantt-month" style={{ width: `calc(var(--gantt-cell) * ${m.span})` }}>
                        {m.label}
                      </div>
                    ))}
                  </div>
                </th>
              </tr>
              <tr className="gantt-days">
                <th className="gantt-time">
                  <div className="gantt-track">
                    {axis.days.map((d) => {
                      const dow = d.date.getDay();
                      return (
                        <div
                          key={d.key}
                          className={`gantt-day${dow === 0 || dow === 6 ? ' is-weekend' : ''}${d.key === today ? ' is-today' : ''}`}
                          title={formatDate(d.key)}
                        >
                          {d.date.getDate()}
                        </div>
                      );
                    })}
                  </div>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => {
                if (r.kind === 'heading') {
                  return (
                    <tr key={`h${i}`} className="gantt-phase">
                      <th scope="row" className="gantt-name" colSpan={4}>
                        {r.label}
                      </th>
                      <td className="gantt-time">
                        <div className="gantt-track" />
                      </td>
                    </tr>
                  );
                }
                if (r.kind === 'phase') {
                  return (
                    <tr key={r.item.id} className="gantt-phase">
                      <th scope="row" className="gantt-name">
                        {r.item.name}
                        {r.tasks === 0 && <span className="faint"> · no tasks</span>}
                      </th>
                      <td className="gantt-date">{r.start ? formatDate(r.start) : <span className="faint">—</span>}</td>
                      <td className="gantt-date">{r.end ? formatDate(r.end) : <span className="faint">—</span>}</td>
                      <td className="gantt-pct">{r.pct !== null ? `${r.pct}%` : ''}</td>
                      <td className="gantt-time">
                        <div className="gantt-track">
                          {todayCol !== null && <div className="gantt-today" style={{ left: `calc(var(--gantt-cell) * ${todayCol})` }} />}
                          <Bar start={r.start} end={r.end} pct={r.pct} tone="phase" />
                        </div>
                      </td>
                    </tr>
                  );
                }
                const t = r.task;
                const tone = TASK_TONES[t.status as keyof typeof TASK_TONES] ?? '';
                const overdue = t.status !== 'DONE' && r.end !== null && r.end < today;
                return (
                  <tr key={t.id} className={`gantt-task${overdue ? ' is-overdue' : ''}`}>
                    <th scope="row" className="gantt-name">
                      {canEdit ? (
                        <button type="button" className="gantt-edit" onClick={() => setEditing(t)} title="Modify this task">
                          {t.name}
                        </button>
                      ) : (
                        t.name
                      )}
                      {t.assignedTo && <span className="faint"> · {t.assignedTo.name}</span>}
                      <StatusBadge status={t.status} extra={TASK_TONES} label={STATUS_LABEL[t.status] ?? t.status} />
                    </th>
                    <td className="gantt-date">{r.start ? formatDate(r.start) : <span className="faint">—</span>}</td>
                    <td className="gantt-date">{r.end ? formatDate(r.end) : <span className="faint">—</span>}</td>
                    <td className="gantt-pct">{t.progressPct}%</td>
                    <td className="gantt-time">
                      <div className="gantt-track">
                        {todayCol !== null && <div className="gantt-today" style={{ left: `calc(var(--gantt-cell) * ${todayCol})` }} />}
                        <Bar start={r.start} end={r.end} pct={t.progressPct} tone={tone || 'plan'} />
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <p className="faint del-note gantt-legend">
        <span className="gantt-key tone-plan" /> planned <span className="gantt-key tone-info" /> in progress{' '}
        <span className="gantt-key tone-ok" /> done <span className="gantt-key tone-danger" /> blocked · the darker part of a
        bar is the percent complete · the red line is today
      </p>

      {editing && (
        // A fresh form (and a fresh Remove question) for each task: without
        // the key, opening task B over task A kept A's values and saved them on B.
        <TaskEditor
          key={editing === 'new' ? 'new' : editing.id}
          jobId={jobId}
          task={editing === 'new' ? null : editing}
          scopeItems={scopeItems}
          onClose={() => setEditing(null)}
          onSaved={async () => {
            setEditing(null);
            await onChanged();
          }}
        />
      )}
    </div>
  );
}

/** One task's facts, edited in place under the chart — a panel, not a dialog. */
function TaskEditor({
  jobId,
  task,
  scopeItems,
  onClose,
  onSaved,
}: {
  jobId: string;
  task: GanttTask | null;
  scopeItems: GanttScopeItem[];
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const { people } = usePeople();
  const assigneeId = useId();
  const [form, setForm] = useState({
    name: task?.name ?? '',
    scopeItemId: task?.scopeItemId ?? scopeItems[0]?.id ?? '',
    startDate: keyOf(task?.startDate) ?? '',
    dueDate: keyOf(task?.dueDate) ?? '',
    progressPct: task?.progressPct ?? 0,
    status: task?.status ?? 'NOT_STARTED',
    assignedToId: task?.assignedTo?.id ?? '',
  });

  const valid = form.name.trim().length >= 2 && (!form.startDate || !form.dueDate || form.dueDate >= form.startDate);

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const dates = {
        scopeItemId: form.scopeItemId || null,
        startDate: form.startDate || null,
        dueDate: form.dueDate || null,
        assignedToId: form.assignedToId || null,
      };
      if (task) {
        await api.patch(`/jobs/${jobId}/tasks/${task.id}`, {
          name: form.name.trim(),
          status: form.status,
          progressPct: Number(form.progressPct),
          ...dates,
        });
      } else {
        const created = await api.post<{ id: string }>(`/jobs/${jobId}/tasks`, { name: form.name.trim(), ...dates });
        if (form.status !== 'NOT_STARTED' || Number(form.progressPct) > 0) {
          await api.patch(`/jobs/${jobId}/tasks/${created.id}`, { status: form.status, progressPct: Number(form.progressPct) });
        }
      }
      toast('ok', task ? 'Task updated' : 'Task added');
      await onSaved();
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  }

  /** Asked in the panel's foot first; a refusal is shown there, beside the question. */
  async function remove() {
    if (!task) return;
    await api.del(`/jobs/${jobId}/tasks/${task.id}`);
    toast('ok', 'Task removed');
    await onSaved();
  }

  return (
    <section className="gantt-editor" aria-label={task ? `Modify task ${task.name}` : 'Add task'}>
      <h4 className="card-title">{task ? 'Modify task' : 'Add task'}</h4>
      <ErrorBox error={error} />
      <div className="grid grid-2">
        <Field label="Task" required>
          <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Site survey, piping, testing…" />
        </Field>
        <Field label="Scope line">
          <select value={form.scopeItemId} onChange={(e) => setForm({ ...form, scopeItemId: e.target.value })}>
            <option value="">— not under a scope line —</option>
            {scopeItems.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Start">
          <input type="date" value={form.startDate} onChange={(e) => setForm({ ...form, startDate: e.target.value })} />
        </Field>
        <Field label="Due" error={form.startDate && form.dueDate && form.dueDate < form.startDate ? 'It ends before it starts' : null}>
          <input type="date" value={form.dueDate} onChange={(e) => setForm({ ...form, dueDate: e.target.value })} />
        </Field>
        <Field label="Status">
          <select value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value, progressPct: e.target.value === 'DONE' ? 100 : form.progressPct })}>
            {Object.entries(STATUS_LABEL).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Percent complete">
          <NumberInput
            kind="percent"
            min={0}
            max={100}
            value={form.progressPct}
            onChange={(e) => setForm({ ...form, progressPct: Math.max(0, Math.min(100, Number(e.target.value) || 0)) })}
          />
        </Field>
        <Field label="Assigned to" htmlFor={assigneeId}>
          <PersonSelect
            id={assigneeId}
            value={form.assignedToId}
            onChange={(id) => setForm((f) => ({ ...f, assignedToId: id }))}
            people={people}
            placeholder="— nobody —"
            current={task?.assignedTo}
          />
        </Field>
      </div>
      {/* The modal foot's order in a panel: [Remove] … [Cancel] [Save]. */}
      <div className="panel-foot">
        <ModalFoot
          onCancel={onClose}
          busy={busy}
          danger={
            task
              ? { label: 'Remove', question: `Remove the task “${task.name}”? It cannot be undone.`, onConfirm: remove }
              : undefined
          }
        >
          <button type="button" className="btn btn-primary" onClick={save} disabled={busy || !valid}>
            {busy ? 'Saving…' : 'Save'}
          </button>
        </ModalFoot>
      </div>
    </section>
  );
}
