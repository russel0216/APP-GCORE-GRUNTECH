import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../../lib/api';
import { useAuth, mayEditPage } from '../../lib/auth';
import { dayKeyOf, parseDay } from '../../lib/day';
import { DataList, type Column } from '../../components/DataList';
import { Stat } from '../../components/charts';
import { RecordHeader } from '../../components/RecordHeader';
import { Attachments } from '../../components/Attachments';
import { SettingListCard } from '../../components/SettingListCard';
import { ErrorBox, Field, Loading, StatusBadge, formatDate, formatDateTime, useToast, type Tone } from '../../components/ui';

/**
 * People Flow (2026-10-13) — one person's path from pre-boarding to the
 * clearance certificate, after the owner's PEOPLE_FLOW file: Onboarding,
 * Integration, Development & Growth, Retention & Engagement, Separation.
 *
 * The rules are the API's (`shared/peopleFlow.ts`): the checklist is HR
 * Settings' `hr.peopleFlow`, the stage is derived, and an item a record
 * answers for — the probation review, skill building, the clearance's — reads
 * that record and is never ticked here, only waived with a reason. HR
 * (`ghr.people_flow.edit_all`) records the rest; a person reads their own
 * path; a supervisor with the HR dashboard right their direct reports'.
 */

type Stage = 'ONBOARDING' | 'INTEGRATION' | 'DEVELOPMENT' | 'RETENTION' | 'SEPARATION';
type ItemStatus = 'PENDING' | 'DONE' | 'WAIVED' | 'NA';

const STAGES: { key: Stage; label: string }[] = [
  { key: 'ONBOARDING', label: 'Onboarding' },
  { key: 'INTEGRATION', label: 'Integration' },
  { key: 'DEVELOPMENT', label: 'Development & Growth' },
  { key: 'RETENTION', label: 'Retention & Engagement' },
  { key: 'SEPARATION', label: 'Separation' },
];

export const FLOW_TONES: Record<string, Tone> = {
  ONBOARDING: 'info',
  INTEGRATION: 'info',
  DEVELOPMENT: 'ok',
  RETENTION: 'ok',
  SEPARATION: 'warn',
  PENDING: 'warn',
  DONE: 'ok',
  WAIVED: 'info',
  NA: '',
};

const ITEM_LABEL: Record<ItemStatus, string> = { PENDING: 'Open', DONE: 'Done', WAIVED: 'Waived', NA: 'Not applicable' };

interface FlowItem {
  key: string;
  stage: Stage;
  title: string;
  description: string | null;
  source: string | null;
  derived: boolean;
  status: ItemStatus;
  fact: string | null;
  link: string | null;
  dueOn: string | null;
  overdue: boolean;
  doneOn: string | null;
  notes: string | null;
  by: string | null;
  at: string | null;
}

interface FlowPath {
  employee: {
    id: string;
    employeeNo: string;
    name: string;
    position: string | null;
    department: { id: string; name: string } | null;
    employmentType: string;
    isActive: boolean;
    self: boolean;
  };
  stage: Stage;
  stageLabel: string;
  hiredOn: string | null;
  probationEndOn: string | null;
  items: FlowItem[];
  open: number;
  overdue: number;
  stages: { key: Stage; label: string; blurb: string }[];
  sources: Record<string, string>;
  canEdit: boolean;
}

interface FlowRow {
  id: string;
  employeeNo: string;
  name: string;
  position: string | null;
  department: { id: string; name: string } | null;
  hiredOn: string | null;
  stage: Stage;
  stageLabel: string;
  open: number;
  overdue: number;
  next: { key: string; title: string; dueOn: string | null } | null;
  probationDueOn: string | null;
}

interface FlowSummary {
  total: number;
  stages: Record<Stage, number>;
  overdue: number;
  probationDue: number;
}

/** A DATE key on screen — never `new Date('YYYY-MM-DD')`, which is UTC (lib/day.ts). */
const day = (key: string | null | undefined) => (key ? formatDate(parseDay(key)) : '—');

// ── The list ─────────────────────────────────────────────────────────────────

export function PeopleFlow() {
  const navigate = useNavigate();
  const { can } = useAuth();
  const all = can('ghr.people_flow.view_all');
  const supervises = can('ghr.dashboard.view_all');
  const [departments, setDepartments] = useState<{ id: string; name: string }[]>([]);

  useEffect(() => {
    if (all) api.get<{ id: string; name: string }[]>('/departments').then(setDepartments).catch(() => {});
  }, [all]);

  const columns: Column<FlowRow>[] = [
    {
      key: 'name',
      label: 'Employee',
      sortKey: 'name',
      render: (r) => (
        <>
          {r.name}
          <div className="faint">{[r.employeeNo, r.position].filter(Boolean).join(' · ')}</div>
        </>
      ),
    },
    { key: 'department', label: 'Department', render: (r) => r.department?.name ?? '—' },
    { key: 'hired', label: 'Hired', sortKey: 'hired', render: (r) => day(r.hiredOn) },
    { key: 'stage', label: 'Stage', sortKey: 'stage', render: (r) => <StatusBadge status={r.stage} extra={FLOW_TONES} label={r.stageLabel} /> },
    { key: 'open', label: 'Open', sortKey: 'open', align: 'right', render: (r) => r.open },
    {
      key: 'overdue',
      label: 'Overdue',
      sortKey: 'overdue',
      align: 'right',
      render: (r) => (r.overdue ? <StatusBadge status="OVERDUE" extra={{ OVERDUE: 'danger' }} label={String(r.overdue)} /> : '—'),
    },
    {
      key: 'next',
      label: 'Next',
      render: (r) =>
        r.next ? (
          <>
            {r.next.title}
            {r.next.dueOn && <div className="faint">due {day(r.next.dueOn)}</div>}
          </>
        ) : (
          '—'
        ),
    },
  ];

  const list = (props: { reports?: boolean }) => (
    <DataList<FlowRow>
      listKey={props.reports ? 'people-flow-reports' : 'people-flow'}
      endpoint="/people-flow"
      printPath="/api/people-flow/pdf"
      columns={columns}
      rowKey={(r) => r.id}
      selectable={all}
      urlState={!props.reports}
      initialFilters={props.reports ? { reports: 'true' } : undefined}
      searchPlaceholder="Search name, employee number or position…"
      onRowClick={(r) => navigate(`/g-hr/people-flow/${r.id}`)}
      emptyTitle={props.reports ? 'Nobody reports to you' : 'Nobody to show'}
      emptyHint={props.reports ? 'Your direct reports’ paths appear here once Admin › Users names you as their “Reports to”.' : 'Active employees appear here with the stage of their path.'}
      filters={[
        { key: 'stage', label: 'Stage', options: STAGES.map((s) => ({ value: s.key, label: s.label })) },
        { key: 'overdue', label: 'Overdue', options: [{ value: 'true', label: 'With an overdue item' }] },
        { key: 'probation', label: 'Probation review', options: [{ value: 'due', label: 'Due within a week, or overdue' }] },
        ...(all ? [{ key: 'departmentId', label: 'Department', options: departments.map((d) => ({ value: d.id, label: d.name })) }] : []),
      ]}
      summary={
        all
          ? (raw) => {
              const s = raw as unknown as FlowSummary;
              return (
                <>
                  {STAGES.map((st) => (
                    <Stat key={st.key} label={st.label} value={s.stages?.[st.key] ?? 0} to={`/g-hr/people-flow?stage=${st.key}`} />
                  ))}
                  <Stat label="With overdue items" value={s.overdue ?? 0} accent={s.overdue ? 'danger' : undefined} to="/g-hr/people-flow?overdue=true" />
                  <Stat label="Probation reviews due" value={s.probationDue ?? 0} accent={s.probationDue ? 'warn' : undefined} to="/g-hr/people-flow?probation=due" />
                </>
              );
            }
          : undefined
      }
    />
  );

  if (all) {
    return (
      <div>
        <div className="page-head">
          <h1>People Flow</h1>
        </div>
        {list({})}
      </div>
    );
  }

  return (
    <div>
      <div className="page-head">
        <h1>People Flow</h1>
      </div>
      <MyPath />
      {supervises && (
        <>
          <h2 className="flow-section-title">My direct reports</h2>
          {list({ reports: true })}
        </>
      )}
    </div>
  );
}

/** The signed-in person's own path, under the list's title. */
function MyPath() {
  const [path, setPath] = useState<FlowPath | null>(null);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => {
    api.get<FlowPath>('/people-flow/mine').then(setPath).catch(setError);
  }, []);
  if (error) return <ErrorBox error={error} />;
  if (!path) return <Loading />;
  return (
    <>
      <p className="muted">
        You stand in <strong>{path.stageLabel}</strong>. HR records each step; ask HR when something here is not right.
      </p>
      <FlowStages path={path} onChange={setPath} />
    </>
  );
}

// ── One person's path ────────────────────────────────────────────────────────

export function PeopleFlowPage() {
  const { employeeId } = useParams<{ employeeId: string }>();
  const [path, setPath] = useState<FlowPath | null>(null);
  const [error, setError] = useState<unknown>(null);

  const load = useCallback(() => {
    api.get<FlowPath>(`/people-flow/${employeeId}`).then(setPath).catch(setError);
  }, [employeeId]);
  useEffect(load, [load]);

  if (error && !path) return <ErrorBox error={error} />;
  if (!path) return <Loading />;
  const e = path.employee;

  return (
    <div>
      <RecordHeader
        type="People Flow"
        code={e.employeeNo}
        title={e.name}
        status={path.stage}
        statusLabel={path.stageLabel}
        statusExtra={FLOW_TONES}
        meta={
          <>
            {[e.position, e.department?.name, humaniseType(e.employmentType)].filter(Boolean).join(' · ')}
            {' · '}
            {path.hiredOn ? `hired ${day(path.hiredOn)}` : 'no hire date on file'}
            {path.probationEndOn && ` · probation ends ${day(path.probationEndOn)}`}
            {!e.isActive && ' · no longer active'}
          </>
        }
      />
      <FlowStages path={path} onChange={setPath} />
    </div>
  );
}

const humaniseType = (t: string) => t.charAt(0) + t.slice(1).toLowerCase().replace(/_/g, '-');

/** The employee record's People Flow tab: the same path, and the way to its own page. */
export function EmployeeFlowTab({ employeeId }: { employeeId: string }) {
  const [path, setPath] = useState<FlowPath | null>(null);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => {
    api.get<FlowPath>(`/people-flow/${employeeId}`).then(setPath).catch(setError);
  }, [employeeId]);
  if (error) return <ErrorBox error={error} />;
  if (!path) return <Loading />;
  return (
    <>
      <p className="muted">
        Stands in <StatusBadge status={path.stage} extra={FLOW_TONES} label={path.stageLabel} /> —{' '}
        <Link to={`/g-hr/people-flow/${employeeId}`}>open the whole path</Link>.
      </p>
      <FlowStages path={path} onChange={setPath} />
    </>
  );
}

/** The five stages: a strip saying where the person stands, then each stage's items. */
function FlowStages({ path, onChange }: { path: FlowPath; onChange: (p: FlowPath) => void }) {
  const current = STAGES.findIndex((s) => s.key === path.stage);
  return (
    <>
      <ol className="flow-strip" aria-label="Stages">
        {path.stages.map((s, i) => {
          const items = path.items.filter((it) => it.stage === s.key);
          const closed = items.filter((it) => it.status !== 'PENDING').length;
          return (
            <li key={s.key} className={i === current ? 'is-current' : i < current ? 'is-past' : ''} aria-current={i === current ? 'step' : undefined}>
              <span className="flow-strip-name">{s.label}</span>
              <span className="flow-strip-count">
                {closed} of {items.length}
              </span>
            </li>
          );
        })}
      </ol>
      {path.stages.map((s) => {
        const items = path.items.filter((it) => it.stage === s.key);
        if (!items.length) return null;
        return (
          <section key={s.key} className={`card flow-stage${s.key === path.stage ? ' is-current' : ''}`}>
            <h3 className="card-title">
              {s.label}
              {s.key === path.stage && <span className="badge info flow-here">Here now</span>}
            </h3>
            <p className="faint">{s.blurb}</p>
            <ul className="flow-items">
              {items.map((it) => (
                <FlowItemRow key={it.key} item={it} path={path} onChange={onChange} />
              ))}
            </ul>
          </section>
        );
      })}
    </>
  );
}

function FlowItemRow({ item, path, onChange }: { item: FlowItem; path: FlowPath; onChange: (p: FlowPath) => void }) {
  const toast = useToast();
  const today = dayKeyOf(new Date());
  const [open, setOpen] = useState(false);
  const [files, setFiles] = useState(false);
  const [status, setStatus] = useState<ItemStatus>('DONE');
  const [doneOn, setDoneOn] = useState(today);
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  function start() {
    setStatus(item.derived ? 'WAIVED' : item.status === 'PENDING' ? 'DONE' : item.status);
    setDoneOn(item.doneOn ?? today);
    setNotes(item.notes ?? '');
    setError(null);
    setOpen(true);
  }

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const next = await api.put<FlowPath>(`/people-flow/${path.employee.id}/items/${item.key}`, {
        status,
        doneOn: status === 'DONE' || status === 'WAIVED' ? doneOn : null,
        notes: notes.trim() || null,
      });
      onChange(next);
      setOpen(false);
      toast('ok', `${item.title}: ${ITEM_LABEL[status].toLowerCase()}`);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  const statusChoices: { value: ItemStatus; label: string }[] = item.derived
    ? [
        { value: 'WAIVED', label: 'Waived' },
        { value: 'PENDING', label: 'Follow the record again' },
      ]
    : [
        { value: 'DONE', label: 'Done' },
        { value: 'NA', label: 'Not applicable' },
        { value: 'WAIVED', label: 'Waived' },
        { value: 'PENDING', label: 'Open again' },
      ];

  return (
    <li className={`flow-item${item.overdue ? ' is-overdue' : ''}`}>
      <div className="flow-item-head">
        <StatusBadge status={item.overdue ? 'OVERDUE' : item.status} extra={{ ...FLOW_TONES, OVERDUE: 'danger' }} label={item.overdue ? 'Overdue' : ITEM_LABEL[item.status]} />
        <div className="flow-item-main">
          <strong>{item.title}</strong>
          {item.description && <div className="faint">{item.description}</div>}
          {item.derived && (
            <div className="flow-item-fact">
              Follows: {path.sources[item.source ?? ''] ?? 'its record'}
              {item.fact && (
                <>
                  {' — '}
                  {item.link ? <Link to={item.link}>{item.fact}</Link> : item.fact}
                </>
              )}
            </div>
          )}
          {(item.status !== 'PENDING' || item.notes) && (
            <div className="flow-item-done">
              {item.status === 'DONE' && item.doneOn && <>Done {day(item.doneOn)}</>}
              {item.status === 'WAIVED' && <>Waived{item.doneOn ? ` ${day(item.doneOn)}` : ''}</>}
              {item.status === 'NA' && <>Not applicable</>}
              {item.by && (
                <span className="faint">
                  {' '}
                  · recorded by {item.by}
                  {item.at ? `, ${formatDateTime(item.at)}` : ''}
                </span>
              )}
            </div>
          )}
          {item.notes && <p className="flow-notes">{item.notes}</p>}
        </div>
        <div className="flow-item-aside">
          {item.status === 'PENDING' && item.dueOn && <span className={item.overdue ? 'flow-due is-overdue' : 'flow-due'}>Due {day(item.dueOn)}</span>}
          <div className="flow-item-actions">
            <button type="button" className="btn btn-sm" onClick={() => setFiles((f) => !f)} aria-expanded={files}>
              Files
            </button>
            {path.canEdit && !open && (!item.derived || item.status === 'PENDING' || item.status === 'WAIVED') && (
              <button type="button" className="btn btn-sm" onClick={start}>
                {item.derived ? 'Waive…' : 'Record…'}
              </button>
            )}
          </div>
        </div>
      </div>

      {open && (
        <div className="flow-panel">
          <ErrorBox error={error} />
          <div className="grid grid-2">
            <Field label="Status">
              <select value={status} onChange={(e) => setStatus(e.target.value as ItemStatus)}>
                {statusChoices.map((c) => (
                  <option key={c.value} value={c.value}>
                    {c.label}
                  </option>
                ))}
              </select>
            </Field>
            {(status === 'DONE' || status === 'WAIVED') && (
              <Field label={status === 'DONE' ? 'Done on' : 'Waived on'}>
                <input type="date" value={doneOn} max={today} onChange={(e) => setDoneOn(e.target.value)} />
              </Field>
            )}
          </div>
          <Field
            label={status === 'WAIVED' ? 'Why it is waived' : 'Notes'}
            required={status === 'WAIVED'}
            hint={status === 'WAIVED' ? undefined : 'The 30-60-90 goals, what was said in the interview, who the buddy is…'}
          >
            <textarea rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} />
          </Field>
          <div className="flow-panel-actions">
            <button type="button" className="btn btn-sm" onClick={() => setOpen(false)} disabled={busy}>
              Cancel
            </button>
            <button type="button" className="btn btn-sm btn-primary" onClick={() => void save()} disabled={busy || (status === 'WAIVED' && notes.trim().length < 3)}>
              {busy ? 'Saving…' : 'Save'}
            </button>
          </div>
        </div>
      )}

      {files && (
        <div className="flow-files">
          <Attachments entityType="employee_flow_item" entityId={`${path.employee.id}~${item.key}`} title={`Files — ${item.title}`} canEdit={path.canEdit} />
        </div>
      )}
    </li>
  );
}

// ── HR Settings › People Flow ────────────────────────────────────────────────

const SOURCES = [
  { value: '', label: 'Ticked by HR' },
  { value: 'probation_review', label: 'The probation evaluation' },
  { value: 'training', label: 'Verified training (Academy)' },
  { value: 'clearance_raised', label: 'A clearance raised' },
  { value: 'clearance_handover', label: 'The clearance’s handover lines' },
  { value: 'clearance_property', label: 'The clearance’s property lines and the login' },
  { value: 'clearance_cleared', label: 'The clearance approved' },
];

export function PeopleFlowCard() {
  const { can } = useAuth();
  return (
    <SettingListCard
      settingKey="hr.peopleFlow"
      title="People Flow"
      hint="The path every person walks, stage by stage. Due (days) counts from the hire date for Onboarding and Integration and from the last working day for Separation (negative is before it); Development and Retention have no due date. An item that follows a record is never ticked by hand. A key is permanent — rename the item freely."
      columns={[
        { key: 'stage', label: 'Stage', kind: 'select', options: STAGES.map((s) => ({ value: s.key, label: s.label })) },
        { key: 'key', label: 'Key', kind: 'text' },
        { key: 'title', label: 'Item', kind: 'text' },
        { key: 'description', label: 'What it covers', kind: 'text' },
        { key: 'dueDays', label: 'Due (days)', kind: 'number', step: 1, min: -365, max: 730 },
        { key: 'source', label: 'Follows', kind: 'select', options: SOURCES },
      ]}
      newRow={() => ({ stage: 'ONBOARDING', key: '', title: '', description: '', dueDays: null, source: '' })}
      canEdit={mayEditPage(can, 'ghr', 'settings')}
    />
  );
}
