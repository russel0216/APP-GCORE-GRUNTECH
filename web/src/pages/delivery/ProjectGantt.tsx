import { useCallback, useEffect, useId, useMemo, useState } from 'react';
import { api, openPdf } from '../../lib/api';
import { addDays, daysBetween, mondayOf, parseDay, todayLocal } from '../../lib/day';
import { Empty, ErrorBox, Field, ModalFoot, StatusBadge, formatDate, useToast } from '../../components/ui';
import { NumberInput } from '../../components/NumberInput';
import { PersonSelect, usePeople } from '../../components/People';
import { useHolidayKeys } from '../../lib/holidays';
import { useConfirm } from '../../components/Confirm';
import { ApprovalStepper, DecisionNote, DocumentApproval, previewSteps, type PreviewRoute } from '../../components/ApprovalStepper';

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
  /** A change to its dates waiting for the Technical Manager (2026-11-03). */
  proposalPending?: boolean;
  proposedStart?: string | null;
  proposedEnd?: string | null;
}

/** The phases' date change waiting to be sent or decided (`GET /jobs/:id/schedule-change`). */
interface ScheduleChange {
  status: 'DRAFT' | 'PENDING_APPROVAL';
  phases: { id: string; name: string; plannedStart: string | null; plannedEnd: string | null; proposedStart: string | null; proposedEnd: string | null }[];
  canSubmit: boolean;
  canWithdraw: boolean;
  canDiscard: boolean;
  approvalRoute: PreviewRoute | null;
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
  /** Its weight in its phase (2026-10-15); none counts as 1. A Decimal, so it may arrive as text. */
  weight?: number | string | null;
  /** A milestone on the kick-off Gantt chart (2026-10-22). */
  isMilestone?: boolean;
}

/** A task's weight, 1 when none is set — the progress report's "from tasks" rule. */
const weightOf = (t: GanttTask) => (t.weight === null || t.weight === undefined || t.weight === '' ? 1 : Number(t.weight));

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
  | { kind: 'phase'; item: GanttScopeItem; start: string | null; end: string | null; pct: number | null; tasks: number; proposed: { start: string | null; end: string | null } | null }
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
  // Holidays are days off like Sunday (2026-10-17), shaded the same.
  const holidayKeys = useHolidayKeys();
  const toast = useToast();
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<GanttTask | 'new' | null>(null);
  const [editingPhase, setEditingPhase] = useState<{ item: GanttScopeItem; start: string | null; end: string | null; tasks: number } | null>(null);
  const [change, setChange] = useState<ScheduleChange | null>(null);
  const [changeReload, setChangeReload] = useState(0);
  const confirm = useConfirm();
  const loadChange = useCallback(async () => {
    try {
      setChange((await api.get<{ scheduleChange: ScheduleChange | null }>(`/jobs/${jobId}/schedule-change`)).scheduleChange);
    } catch {
      setChange(null);
    }
  }, [jobId]);
  const proposalKey = scopeItems.map((s) => `${s.id}:${s.proposalPending ? 1 : 0}:${s.proposedStart}:${s.proposedEnd}`).join('|');
  useEffect(() => {
    loadChange();
  }, [loadChange, proposalKey]);
  const waiting = change?.status === 'PENDING_APPROVAL';

  async function changeAction(path: 'submit' | 'withdraw' | 'discard', message: string) {
    setBusy(true);
    setError(null);
    try {
      const r = await api.post<{ scheduleChange: ScheduleChange | null }>(`/jobs/${jobId}/schedule-change/${path}`);
      setChange(r.scheduleChange);
      setChangeReload((n) => n + 1);
      toast('ok', message);
      await onChanged();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

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
      // The phase's % is its tasks' weighted by their weights — what the
      // progress report takes "from tasks".
      const weights = own.reduce((s, t) => s + weightOf(t), 0);
      const pct = own.length && weights > 0 ? Math.round(own.reduce((s, t) => s + weightOf(t) * (t.status === 'DONE' ? 100 : t.progressPct), 0) / weights) : null;
      out.push({
        kind: 'phase',
        item,
        start: keyOf(item.plannedStart) ?? (starts.length ? starts.sort()[0] : null),
        end: keyOf(item.plannedEnd) ?? (ends.length ? ends.sort()[ends.length - 1] : null),
        pct,
        tasks: own.length,
        proposed: item.proposalPending ? { start: keyOf(item.proposedStart), end: keyOf(item.proposedEnd) } : null,
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

  /** Every phase with dated tasks takes its tasks' span (2026-11-03). */
  async function fitAllPhases() {
    setBusy(true);
    setError(null);
    try {
      const r = await api.patch<{ changed: number }>(`/jobs/${jobId}/scope-items/all`, { fromTasks: true });
      toast('ok', r.changed ? `${r.changed} phase${r.changed === 1 ? '' : 's'} proposed on their tasks’ dates — send the change to the Technical Manager` : 'Every phase already matches its tasks');
      await onChanged();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  // A phase whose stored dates differ from its tasks' span — worth a nudge.
  const offTasks = rows.some((r) => {
    if (r.kind !== 'phase' || !r.tasks) return false;
    const own = tasks.filter((t) => t.scopeItemId === r.item.id);
    const s = own.map((t) => keyOf(t.startDate) ?? keyOf(t.dueDate)).filter((k): k is string => !!k).sort();
    const e = own.map((t) => keyOf(t.dueDate) ?? keyOf(t.startDate)).filter((k): k is string => !!k).sort();
    const start = r.proposed ? r.proposed.start : r.start;
    const end = r.proposed ? r.proposed.end : r.end;
    return s.length > 0 && (s[0] !== start || e[e.length - 1] !== end);
  });

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
      <div className="card-head">
        <h3 className="card-title">Scope of work — Gantt chart</h3>
        <div className="row">
          {/* The tab on paper: phases, tasks and the chart (2026-10-21). */}
          <button type="button" className="btn btn-sm" onClick={() => openPdf(`/api/jobs/${jobId}/scope/pdf`, setError)}>
            Print
          </button>
          {canEdit && hasCosting && (
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
          {canEdit && offTasks && !waiting && (
            <button
              type="button"
              className="btn btn-sm"
              onClick={fitAllPhases}
              disabled={busy}
              title="Move every phase to its tasks’ dates — the first task’s start to the last task’s due date"
            >
              Fit phases to tasks
            </button>
          )}
          {canEdit && (
            <button type="button" className="btn btn-sm" onClick={() => setEditing('new')} disabled={busy}>
              + Add task
            </button>
          )}
        </div>
      </div>
      <p className="muted del-lede">
        Each scope line is a phase; its tasks sit under it. A bar runs from a task’s start to its due date and fills
        to its percent complete. A phase’s planned dates come from the costing’s scope of work, in working days from
        the start date — click a phase to propose new dates or fit them to its tasks. A change takes effect once the
        project’s Technical Manager approves it; the planned S-curve reads the approved dates.
      </p>
      {confirm.bar}
      <ErrorBox error={error} />
      {change && (
        <div className={`alert ${waiting ? 'info' : 'warn'}`}>
          <strong>
            {waiting
              ? 'Phase date change — waiting for the Technical Manager’s approval'
              : `Phase date change not yet sent — ${change.phases.length} phase${change.phases.length === 1 ? '' : 's'}`}
          </strong>
          <ul>
            {change.phases.map((p) => (
              <li key={p.id}>
                {p.name}: {p.plannedStart ? `${formatDate(p.plannedStart)} – ${formatDate(p.plannedEnd ?? p.plannedStart)}` : 'no dates'} →{' '}
                <strong>{p.proposedStart ? `${formatDate(p.proposedStart)} – ${formatDate(p.proposedEnd ?? p.proposedStart)}` : 'no dates'}</strong>
              </li>
            ))}
          </ul>
          {change.status === 'DRAFT' && change.approvalRoute && change.approvalRoute.steps.length > 0 && (
            <div className="qd-route">
              <span className="qd-route-label">Sending it goes to</span>
              <ApprovalStepper steps={previewSteps(change.approvalRoute)} />
            </div>
          )}
          <div className="row">
            {change.canSubmit && (
              <button type="button" className="btn btn-sm btn-primary" disabled={busy} onClick={() => changeAction('submit', 'Sent to the Technical Manager for approval')}>
                Send to the Technical Manager
              </button>
            )}
            {change.canWithdraw && (
              <button
                type="button"
                className="btn btn-sm"
                disabled={busy}
                onClick={() =>
                  confirm.ask({
                    title: 'Pull the date change back?',
                    body: 'The Technical Manager’s request is withdrawn and they are told. The proposed dates stay, to change and send again.',
                    confirmLabel: 'Pull it back',
                    onConfirm: () => changeAction('withdraw', 'Pulled back — change it and send it again'),
                  })
                }
              >
                Pull back
              </button>
            )}
            {change.canDiscard && (
              <button
                type="button"
                className="btn btn-sm btn-danger"
                disabled={busy}
                onClick={() =>
                  confirm.ask({
                    title: 'Discard the proposed dates?',
                    body: 'Every phase keeps its approved dates.',
                    confirmLabel: 'Discard',
                    onConfirm: () => changeAction('discard', 'Proposed dates discarded'),
                  })
                }
              >
                Discard
              </button>
            )}
          </div>
        </div>
      )}
      <DecisionNote documentType="schedule_change" documentId={jobId} reloadToken={changeReload} />
      {waiting && <DocumentApproval documentType="schedule_change" documentId={jobId} reloadToken={changeReload} compact />}

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
                          className={`gantt-day${dow === 0 || holidayKeys.has(d.key) ? ' is-off' : ''}${d.key === today ? ' is-today' : ''}`}
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
                        {canEdit && !waiting ? (
                          <button
                            type="button"
                            className="gantt-edit"
                            onClick={() =>
                              setEditingPhase({ item: r.item, start: r.proposed ? r.proposed.start : r.start, end: r.proposed ? r.proposed.end : r.end, tasks: r.tasks })
                            }
                            title="Propose new dates for this phase — the Technical Manager approves them"
                          >
                            {r.item.name}
                          </button>
                        ) : (
                          r.item.name
                        )}
                        {r.tasks === 0 && <span className="faint"> · no tasks</span>}
                        {r.proposed && (
                          <span className="faint">
                            {' '}
                            · proposed {r.proposed.start ? `${formatDate(r.proposed.start)} – ${formatDate(r.proposed.end ?? r.proposed.start)}` : 'no dates'}
                            {waiting ? ', waiting for approval' : ', not yet sent'}
                          </span>
                        )}
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
                          {t.isMilestone && <span aria-label="Milestone">◆ </span>}
                          {t.name}
                        </button>
                      ) : (
                        <>
                          {t.isMilestone && <span aria-label="Milestone">◆ </span>}
                          {t.name}
                        </>
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
        bar is the percent complete · the red line is today · ◆ a milestone
      </p>

      {editingPhase && (
        <PhaseEditor
          key={editingPhase.item.id}
          jobId={jobId}
          phase={editingPhase}
          onClose={() => setEditingPhase(null)}
          onSaved={async () => {
            setEditingPhase(null);
            await onChanged();
          }}
        />
      )}

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

/** A phase's planned dates, edited in place under the chart (2026-11-03). */
function PhaseEditor({
  jobId,
  phase,
  onClose,
  onSaved,
}: {
  jobId: string;
  phase: { item: GanttScopeItem; start: string | null; end: string | null; tasks: number };
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [start, setStart] = useState(phase.start ?? '');
  const [end, setEnd] = useState(phase.end ?? '');
  const backwards = !!start && !!end && end < start;

  async function send(body: object, message: string) {
    setBusy(true);
    setError(null);
    try {
      await api.patch(`/jobs/${jobId}/scope-items/${phase.item.id}`, body);
      toast('ok', message);
      await onSaved();
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  }

  return (
    <section className="gantt-editor" aria-label={`Modify phase ${phase.item.name}`}>
      <h4 className="card-title">Modify phase — {phase.item.name}</h4>
      <p className="faint">The new dates are proposed; they take effect once the project’s Technical Manager approves the change.</p>
      <ErrorBox error={error} />
      <div className="grid grid-2">
        <Field label="Planned start">
          <input type="date" value={start} onChange={(e) => setStart(e.target.value)} />
        </Field>
        <Field label="Planned finish" error={backwards ? 'It ends before it starts' : null}>
          <input type="date" value={end} onChange={(e) => setEnd(e.target.value)} />
        </Field>
      </div>
      <div className="panel-foot">
        <ModalFoot onCancel={onClose} busy={busy}>
          {phase.tasks > 0 && (
            <button
              type="button"
              className="btn"
              onClick={() => send({ fromTasks: true }, 'Proposed on its tasks’ dates — send the change to the Technical Manager')}
              disabled={busy}
              title="The first task’s start to the last task’s due date"
            >
              Fit to its tasks
            </button>
          )}
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => send({ plannedStart: start || null, plannedEnd: end || null }, 'Dates proposed — send the change to the Technical Manager')}
            disabled={busy || backwards}
          >
            Propose
          </button>
        </ModalFoot>
      </div>
    </section>
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
    weight: task?.weight === null || task?.weight === undefined ? '' : String(Number(task.weight)),
    isMilestone: !!task?.isMilestone,
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
        weight: form.weight === '' ? null : Number(form.weight),
        isMilestone: form.isMilestone,
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
        <Field label="Weight in its phase" hint="How much of the phase this task is — 1 when left blank. The progress report weighs the phase’s % by it.">
          <NumberInput kind="decimal" value={form.weight} onChange={(e) => setForm({ ...form, weight: e.target.value })} />
        </Field>
        <Field label="Milestone" hint="Drawn as a marker on the kick-off Gantt chart, its name noted under the chart — the customer's kick-off, a delivery, the hand-over">
          <label className="check">
            <input type="checkbox" checked={form.isMilestone} onChange={(e) => setForm({ ...form, isMilestone: e.target.checked })} /> This task is a milestone
          </label>
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
