import { useCallback, useEffect, useId, useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { api, qs } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { DataList, type Column } from '../../components/DataList';
import { CalendarToolbar, MonthCalendar, useCalendarNav, type CalendarEvent } from '../../components/MonthCalendar';
import {
  Checkbox,
  ErrorBox,
  Field,
  Loading,
  Modal,
  ModalFoot,
  StatusBadge,
  formatDate,
  statusTone,
  useToast,
  type Tone,
} from '../../components/ui';
import { monthGrid, monthOf, todayLocal } from '../../lib/day';
import { PersonSelect, loadPeople, usePeople, type PersonRow } from '../../components/People';
import { CustomerPicker, type CustomerRef } from '../../components/CustomerPicker';
import { KINDS, KIND_LABEL, reportPermission } from './Reports';

/**
 * The Service Schedule — every visit, of every kind, on one calendar.
 *
 * A month grid by default, because PM is planned by the month and a visit
 * carries a date rather than a time; a list beside it for sorting, searching
 * and exporting. Both read the same filters from the URL, so a link from a
 * contract, a machine, a notification or a dashboard tile opens exactly what
 * it names, and back/forward undo a change of view.
 *
 * Nothing is dragged. Moving a contractual date is a decision, so it happens
 * in the visit sheet, where the form asks — a mis-drop would move it silently.
 * And a visit is never marked done here: it completes when its report is
 * approved (Phase 8 rule), so the sheet offers "Write report" instead.
 */

/** Visit statuses the global map does not already colour the way this screen means. */
export const VISIT_TONES: Record<string, Tone> = {
  SCHEDULED: 'info',
  MISSED: 'danger',
  CANCELLED: '',
};

export interface ScheduleVisit {
  id: string;
  number: string;
  kind: string;
  status: string;
  sequence: number | null;
  dueDate: string;
  performedAt: string | null;
  daysUntilDue: number;
  overdue: boolean;
  notes: string | null;
  contract: {
    id: string;
    number: string;
    plannedVisits: number;
    job: { id: string; number: string; name: string };
  } | null;
  customer: { id: string; name: string };
  site: { id: string; name: string; city: string | null } | null;
  asset: { id: string; code: string; name: string; serialNo: string | null } | null;
  assignedTo: { id: string; name: string } | null;
  report: { id: string; number: string; status: string; performedAt: string } | null;
  jobOrder: { id: string; number: string; status: string } | null;
}

interface LooseReport {
  id: string;
  number: string;
  kind: string;
  status: string;
  performedAt: string;
  customer: { id: string; name: string };
  performedBy: { id: string; name: string };
}

interface Feed {
  from: string;
  to: string;
  asOf: string;
  visits: ScheduleVisit[];
  reports: LooseReport[];
  engineers: { id: string; name: string }[];
  missedAfterDays: number;
}

/** The word a chip carries, so a status reads without colour. */
function statusWord(v: ScheduleVisit): string {
  if (v.overdue) return 'overdue';
  if (v.status === 'MISSED') return 'missed';
  if (v.status === 'COMPLETED') return 'done';
  if (v.status === 'CANCELLED') return 'cancelled';
  return 'due';
}

function visitTone(v: ScheduleVisit): Tone {
  return v.overdue ? 'warn' : statusTone(v.status, VISIT_TONES);
}

/** Overdue is not a status — it is a SCHEDULED visit past its date, derived on read. */
const BADGE_TONES: Record<string, Tone> = { ...VISIT_TONES, OVERDUE: 'warn' };

export function VisitBadge({ visit }: { visit: Pick<ScheduleVisit, 'status' | 'overdue'> }) {
  return <StatusBadge status={visit.overdue ? 'OVERDUE' : visit.status} extra={BADGE_TONES} />;
}

/** "in 3 days" / "5 days overdue" — only while a visit is still open. */
function dueNote(v: Pick<ScheduleVisit, 'status' | 'daysUntilDue'>): string | null {
  if (v.status !== 'SCHEDULED' && v.status !== 'MISSED') return null;
  if (v.daysUntilDue === 0) return 'today';
  return v.daysUntilDue < 0 ? `${-v.daysUntilDue} days late` : `in ${v.daysUntilDue} days`;
}

/** The URL keys this screen filters by; the calendar and the list share them. */
const FILTER_KEYS = ['assignedToId', 'contractId', 'customerId', 'assetId', 'kind', 'status', 'scope'] as const;

const STATUS_OPTIONS = [
  { value: 'SCHEDULED', label: 'Scheduled' },
  { value: 'COMPLETED', label: 'Completed' },
  { value: 'MISSED', label: 'Missed' },
  { value: 'CANCELLED', label: 'Cancelled' },
];

export function ServiceSchedule() {
  const { can, canView } = useAuth();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const nav = useCalendarNav({ defaultView: 'month', views: ['month'] });
  const mode = params.get('mode') === 'list' ? 'list' : 'month';
  const visitId = params.get('visit');
  const showReports = params.get('reports') !== '0';

  const filters = useMemo(() => {
    const out: Record<string, string> = {};
    for (const key of FILTER_KEYS) {
      const v = params.get(key);
      if (v) out[key] = v;
    }
    return out;
  }, [params]);
  const filterKey = JSON.stringify(filters);

  /** Replaces the given URL keys, leaving everything else — month, view, q — alone. */
  const patch = useCallback(
    (changes: Record<string, string | null>, push = false) => {
      setParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          for (const [k, v] of Object.entries(changes)) {
            if (v) next.set(k, v);
            else next.delete(k);
          }
          return next;
        },
        { replace: !push },
      );
    },
    [setParams],
  );

  // ── The month feed ───────────────────────────────────────────────────────
  const [feed, setFeed] = useState<Feed | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [reload, setReload] = useState(0);

  const grid = useMemo(() => monthGrid(nav.month), [nav.month]);

  useEffect(() => {
    // In list mode the feed is still read once, for the engineer names; a
    // one-day window keeps it cheap.
    const from = mode === 'month' ? grid[0] : todayLocal();
    const to = mode === 'month' ? grid[grid.length - 1] : todayLocal();
    let live = true;
    setLoading(true);
    api
      .get<Feed>(
        `/service-visits/calendar${qs({
          from,
          to,
          ...filters,
          includeReports: mode === 'month' && showReports ? undefined : 'false',
        })}`,
      )
      .then((data) => {
        if (!live) return;
        setFeed(data);
        setError(null);
      })
      .catch((err) => live && setError(err))
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
    // `filters` is represented by filterKey.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nav.windowKey, filterKey, showReports, mode, reload, grid]);

  // ── Filter sources, each hidden when the viewer cannot fill it ───────────
  const [contracts, setContracts] = useState<{ id: string; number: string; job: { name: string } }[]>([]);
  const [customers, setCustomers] = useState<{ id: string; name: string }[]>([]);
  const canContracts = canView('gops', 'service_contracts');
  const canCustomers = can('gops.customers.view_all');

  useEffect(() => {
    if (canContracts) {
      api
        .get<{ rows: typeof contracts }>('/service-contracts?pageSize=200&status=ACTIVE')
        .then((d) => setContracts(d.rows))
        .catch(() => setContracts([]));
    }
    if (canCustomers) {
      api
        .get<{ rows: { id: string; name: string }[] }>('/customers?pageSize=200')
        .then((d) => setCustomers(d.rows))
        .catch(() => setCustomers([]));
    }
  }, [canContracts, canCustomers]);

  const events = useMemo<CalendarEvent[]>(() => {
    if (!feed) return [];
    const visits: CalendarEvent[] = feed.visits.map((v) => ({
      id: `v:${v.id}`,
      date: v.dueDate.slice(0, 10),
      time: null,
      label: v.customer.name,
      detail: `${statusWord(v)} · ${v.asset?.name ?? v.site?.name ?? KIND_LABEL[v.kind]} · ${
        v.assignedTo?.name ?? 'unassigned'
      }`,
      tone: visitTone(v),
      done: v.status === 'COMPLETED' || v.status === 'CANCELLED',
    }));
    const reports: CalendarEvent[] = feed.reports.map((r) => ({
      id: `r:${r.id}`,
      date: r.performedAt.slice(0, 10),
      time: null,
      label: r.customer.name,
      detail: `${KIND_LABEL[r.kind]} report · ${r.performedBy.name}`,
      tone: '',
      done: true,
    }));
    return [...visits, ...reports];
  }, [feed]);

  const byDay = useMemo(() => {
    const s = new Set<string>();
    for (const e of events) s.add(e.date);
    return s;
  }, [events]);

  const [creating, setCreating] = useState(false);
  const activeFilters = Object.keys(filters).length > 0;
  const dayFrom = params.get('from');
  const dayTo = params.get('to');

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Service Schedule</h1>
        </div>
        <div className="row">
          <div className="scope-switch" role="tablist" aria-label="Schedule view">
            <button
              type="button"
              role="tab"
              aria-selected={mode === 'month'}
              className={mode === 'month' ? 'active' : ''}
              onClick={() => patch({ mode: null, from: null, to: null, page: null }, true)}
            >
              Month
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={mode === 'list'}
              className={mode === 'list' ? 'active' : ''}
              onClick={() => patch({ mode: 'list' }, true)}
            >
              List
            </button>
          </div>
          {can('gops.pm_reports.create') && (
            <button type="button" className="btn btn-primary btn-sm" onClick={() => setCreating(true)}>
              + New call-out
            </button>
          )}
        </div>
      </div>

      <div className="list-toolbar svc-filters">
        <select
          aria-label="Engineer"
          value={filters.scope === 'mine' ? 'mine' : (filters.assignedToId ?? '')}
          onChange={(e) => {
            const v = e.target.value;
            patch({ scope: v === 'mine' ? 'mine' : null, assignedToId: v && v !== 'mine' ? v : null, page: null });
          }}
        >
          <option value="">Engineer: everyone</option>
          <option value="mine">Booked on me</option>
          <option value="none">Unassigned</option>
          {(feed?.engineers ?? []).map((e) => (
            <option key={e.id} value={e.id}>
              {e.name}
            </option>
          ))}
        </select>
        {canContracts && (
          <select
            aria-label="Contract"
            value={filters.contractId ?? ''}
            onChange={(e) => patch({ contractId: e.target.value || null, page: null })}
          >
            <option value="">Contract: any</option>
            {contracts.map((c) => (
              <option key={c.id} value={c.id}>
                {c.number} — {c.job.name}
              </option>
            ))}
          </select>
        )}
        {canCustomers && (
          <select
            aria-label="Customer"
            value={filters.customerId ?? ''}
            onChange={(e) => patch({ customerId: e.target.value || null, page: null })}
          >
            <option value="">Customer: any</option>
            {customers.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        )}
        {mode === 'month' && (
          <>
            <select
              aria-label="Kind"
              value={filters.kind ?? ''}
              onChange={(e) => patch({ kind: e.target.value || null })}
            >
              <option value="">Kind: all</option>
              {KINDS.map((k) => (
                <option key={k.value} value={k.value}>
                  {k.label}
                </option>
              ))}
            </select>
            <select
              aria-label="Status"
              value={filters.status ?? ''}
              onChange={(e) => patch({ status: e.target.value || null })}
            >
              <option value="">Status: all</option>
              {STATUS_OPTIONS.map((s) => (
                <option key={s.value} value={s.value}>
                  {s.label}
                </option>
              ))}
            </select>
            <Checkbox
              checked={showReports}
              onChange={(v) => patch({ reports: v ? null : '0' })}
              label="Show reports with no visit"
            />
          </>
        )}
        {filters.assetId && (
          <button type="button" className="btn btn-sm" onClick={() => patch({ assetId: null, page: null })}>
            One machine only — show all ✕
          </button>
        )}
        {activeFilters && (
          <button
            type="button"
            className="btn btn-sm"
            onClick={() =>
              patch({
                assignedToId: null,
                contractId: null,
                customerId: null,
                assetId: null,
                kind: null,
                status: null,
                scope: null,
                page: null,
              })
            }
          >
            Clear filters
          </button>
        )}
      </div>

      <ErrorBox error={error} />

      {mode === 'month' ? (
        <>
          <CalendarToolbar nav={nav} />
          <ul className="cal-legend svc-legend" aria-label="What the chips mean">
            <li>
              <span className="svc-swatch info" aria-hidden="true" />
              due
            </li>
            <li>
              <span className="svc-swatch warn" aria-hidden="true" />
              overdue — still open{feed ? `, missed after ${feed.missedAfterDays} days` : ''}
            </li>
            <li>
              <span className="svc-swatch ok" aria-hidden="true" />
              done — report approved
            </li>
            <li>
              <span className="svc-swatch danger" aria-hidden="true" />
              missed
            </li>
            <li>
              <span className="svc-swatch plain" aria-hidden="true" />
              cancelled, or a report with no visit
            </li>
          </ul>
          <MonthCalendar
            nav={nav}
            events={events}
            loading={loading}
            itemNoun={{ one: 'visit', many: 'visits' }}
            emptyNote={`Nothing scheduled in ${nav.label}${activeFilters ? ' with these filters' : ''}.`}
            onEventClick={(e) => {
              if (e.id.startsWith('v:')) patch({ visit: e.id.slice(2) }, true);
              else navigate(`/g-ops/service-reports/${e.id.slice(2)}`);
            }}
            onDayClick={(day) => {
              // A day with something on it opens as a list of that day — the
              // escape hatch when a hospital's quarterly PMs all fall together.
              if (byDay.has(day)) patch({ mode: 'list', from: day, to: day, page: null }, true);
            }}
          />
        </>
      ) : (
        <>
          {(dayFrom || dayTo) && (
            <div className="alert info svc-day-note">
              <span>
                Visits due {dayFrom === dayTo ? `on ${formatDate(dayFrom)}` : `${formatDate(dayFrom)} – ${formatDate(dayTo)}`}.
              </span>
              <button type="button" className="btn btn-sm" onClick={() => patch({ from: null, to: null, page: null })}>
                Show every date
              </button>
              {dayFrom && (
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={() => patch({ mode: null, from: null, to: null, page: null, month: monthOf(dayFrom) }, true)}
                >
                  Back to the month
                </button>
              )}
            </div>
          )}
          <VisitList
            filters={{
              ...filters,
              ...(dayFrom ? { from: dayFrom } : {}),
              ...(dayTo ? { to: dayTo } : {}),
            }}
            reload={reload}
            onOpen={(id) => patch({ visit: id }, true)}
          />
        </>
      )}

      {visitId && (
        <VisitSheet
          visitId={visitId}
          initial={feed?.visits.find((v) => v.id === visitId) ?? null}
          onClose={() => patch({ visit: null })}
          onChanged={() => setReload((r) => r + 1)}
        />
      )}

      {creating && (
        <NewVisitModal
          onClose={() => setCreating(false)}
          onCreated={(id) => {
            setCreating(false);
            setReload((r) => r + 1);
            patch({ visit: id }, true);
          }}
        />
      )}
    </div>
  );
}

// ── The list ────────────────────────────────────────────────────────────────

function VisitList({
  filters,
  reload,
  onOpen,
}: {
  filters: Record<string, string>;
  reload: number;
  onOpen: (id: string) => void;
}) {
  // status, kind and "due" are the list's own chips (and URL keys); the rest
  // arrive from the filter bar above as a preset.
  const preset = Object.fromEntries(
    Object.entries(filters).filter(([key]) => key !== 'status' && key !== 'kind' && key !== 'scope'),
  );

  const columns: Column<ScheduleVisit>[] = [
    {
      key: 'number',
      label: 'Visit',
      sortKey: 'number',
      render: (r) => (
        <div>
          <span className="mono">{r.number}</span>
          {r.sequence && r.contract && (
            <div className="faint">
              visit {r.sequence} of {r.contract.plannedVisits}
            </div>
          )}
        </div>
      ),
    },
    {
      key: 'dueDate',
      label: 'Due',
      sortKey: 'dueDate',
      render: (r) => (
        <div>
          <div>{formatDate(r.dueDate)}</div>
          {dueNote(r) && <div className="faint">{dueNote(r)}</div>}
        </div>
      ),
    },
    {
      key: 'customer',
      label: 'Customer',
      render: (r) => (
        <div>
          <div>{r.customer.name}</div>
          <div className="faint">{r.asset?.name ?? r.site?.name ?? '—'}</div>
        </div>
      ),
    },
    {
      key: 'kind',
      label: 'Kind',
      optional: true,
      render: (r) => <span className="badge">{KIND_LABEL[r.kind] ?? r.kind}</span>,
    },
    {
      key: 'why',
      label: 'Booked by',
      render: (r) =>
        r.contract ? (
          <Link to={`/g-ops/service-contracts/${r.contract.id}`} className="mono">
            {r.contract.number}
          </Link>
        ) : r.jobOrder ? (
          <Link to={`/g-ops/job-orders/${r.jobOrder.id}`} className="mono">
            {r.jobOrder.number}
          </Link>
        ) : (
          <span className="faint">call-out</span>
        ),
    },
    {
      key: 'assignedTo',
      label: 'Engineer',
      render: (r) => (r.assignedTo ? r.assignedTo.name : <span className="badge warn">unassigned</span>),
    },
    {
      key: 'report',
      label: 'Report',
      render: (r) =>
        r.report ? (
          <Link to={`/g-ops/service-reports/${r.report.id}`} className="mono">
            {r.report.number}
          </Link>
        ) : (
          <span className="faint">—</span>
        ),
    },
    {
      key: 'status',
      label: 'Status',
      render: (r) => <VisitBadge visit={r} />,
    },
  ];

  return (
    <DataList<ScheduleVisit>
      listKey="service-visits"
      endpoint="/service-visits"
      columns={columns}
      rowKey={(r) => r.id}
      initialFilters={preset}
      reloadToken={reload}
      searchPlaceholder="Search visit number, customer, machine…"
      emptyTitle="Nothing scheduled"
      emptyHint="Activating a service contract writes its schedule; an approved job order books its visit."
      onRowClick={(r) => onOpen(r.id)}
      filters={[
        { key: 'status', label: 'Status', options: STATUS_OPTIONS },
        { key: 'due', label: 'Due', options: [{ value: 'true', label: 'Due or overdue' }] },
        { key: 'kind', label: 'Kind', options: KINDS },
      ]}
    />
  );
}

// ── The visit sheet ─────────────────────────────────────────────────────────

/**
 * One visit, opened by `?visit=<id>` from anywhere — a notification, a
 * contract, a machine, a report, a chip on the grid. Read from the server by
 * id, so a link to a visit outside the month on show still opens.
 */
function VisitSheet({
  visitId,
  initial,
  onClose,
  onChanged,
}: {
  visitId: string;
  initial: ScheduleVisit | null;
  onClose: () => void;
  onChanged: () => void;
}) {
  const { can } = useAuth();
  const navigate = useNavigate();
  const toast = useToast();
  const [visit, setVisit] = useState<ScheduleVisit | null>(initial);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [engineers, setEngineers] = useState<PersonRow[]>([]);
  const engineerId = useId();
  const [form, setForm] = useState({ dueDate: '', assignedToId: '', notes: '' });

  const load = useCallback(async () => {
    try {
      const row = await api.get<ScheduleVisit>(`/service-visits/${visitId}`);
      setVisit(row);
      setForm({
        dueDate: row.dueDate.slice(0, 10),
        assignedToId: row.assignedTo?.id ?? '',
        notes: row.notes ?? '',
      });
      setError(null);
    } catch (err) {
      setError(err);
    }
  }, [visitId]);

  useEffect(() => {
    void load();
  }, [load]);

  const canSchedule = can('gops.pm_reports.create');
  useEffect(() => {
    if (!canSchedule) return;
    loadPeople('gops.pm_reports.create')
      .then(setEngineers)
      .catch(() => setEngineers([]));
  }, [canSchedule]);

  /**
   * The PATCH itself; a refusal is thrown, so the cancel's question in the
   * foot can show it. A save that went through closes the sheet, as every
   * modify modal does — staying open would leave the modal believing the
   * saved fields (or the cancel reason typed in the foot) were unsaved.
   */
  async function patchVisit(extra: Record<string, unknown> = {}) {
    if (!visit) return;
    await api.patch(`/service-visits/${visit.id}`, {
      dueDate: form.dueDate,
      assignedToId: form.assignedToId || null,
      notes: form.notes || null,
      ...extra,
    });
    toast('ok', extra.status === 'CANCELLED' ? 'Visit cancelled' : 'Visit updated');
    onChanged();
    onClose();
  }

  async function save(extra: Record<string, unknown> = {}) {
    setBusy(true);
    setError(null);
    try {
      await patchVisit(extra);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  const open = visit && (visit.status === 'SCHEDULED' || visit.status === 'MISSED');
  const editable = !!visit && canSchedule && visit.status !== 'COMPLETED';
  /** The date, the engineer and the notes can be changed — the sheet is a form. */
  const formOpen = editable && visit!.status !== 'CANCELLED';
  const canRestore = editable && visit!.status === 'CANCELLED';
  const canWrite = !!visit && !visit.report && !!open && can(reportPermission(visit.kind, 'create'));
  const title = visit ? (formOpen ? `Modify visit ${visit.number}` : `Visit ${visit.number}`) : 'Visit';

  return (
    <Modal
      title={title}
      onClose={onClose}
      wide
      footer={
        <ModalFoot
          onCancel={onClose}
          cancelLabel={formOpen ? 'Cancel' : 'Close'}
          busy={busy}
          danger={
            formOpen && visit
              ? {
                  label: 'Cancel visit',
                  question: `Cancel ${visit.number}? ${
                    visit.sequence
                      ? 'Regenerating the contract’s schedule rewrites cancelled visits, so this one may come back.'
                      : 'The reason is kept in the visit’s notes.'
                  }`,
                  reason: 'required',
                  reasonLabel: 'Why is it cancelled?',
                  minReason: 3,
                  onConfirm: (reason) => patchVisit({ status: 'CANCELLED', reason }),
                }
              : undefined
          }
        >
          {visit?.report && (
            <Link to={`/g-ops/service-reports/${visit.report.id}`} className="btn">
              Open report {visit.report.number}
            </Link>
          )}
          {canWrite && (
            <button
              type="button"
              className="btn"
              onClick={() => navigate(`/g-ops/service-reports?new=1&visitId=${visit!.id}`)}
            >
              Write report
            </button>
          )}
          {formOpen && (
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => save(visit!.status === 'MISSED' ? { status: 'SCHEDULED' } : {})}
              disabled={busy}
            >
              {busy ? 'Saving…' : visit!.status === 'MISSED' ? 'Reschedule' : 'Save'}
            </button>
          )}
          {canRestore && (
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => save({ status: 'SCHEDULED' })}
              disabled={busy}
            >
              {busy ? 'Saving…' : 'Put it back on the schedule'}
            </button>
          )}
        </ModalFoot>
      }
    >
      <ErrorBox error={error} />
      {!visit ? (
        <Loading />
      ) : (
        <>
          <div className="svc-sheet-head">
            <span className="badge">{KIND_LABEL[visit.kind]}</span>
            <VisitBadge visit={visit} />
            {dueNote(visit) && <span className="faint">{dueNote(visit)}</span>}
          </div>

          {visit.status === 'COMPLETED' && (
            <div className="alert ok">
              Attended on {formatDate(visit.performedAt)}
              {visit.report && (
                <>
                  {' '}and reported as{' '}
                  <Link to={`/g-ops/service-reports/${visit.report.id}`} className="mono">
                    {visit.report.number}
                  </Link>
                </>
              )}
              . This visit is a record of what happened and does not change.
            </div>
          )}
          {visit.status === 'MISSED' && (
            <div className="alert warn">
              Nobody reported this visit in time. Report it now if the work was done, or give it a new
              date.
            </div>
          )}
          {visit.report && visit.report.status === 'REJECTED' && (
            <div className="alert warn">
              Its report was returned. Open it, correct it and submit it again — the visit closes when
              the report is approved.
            </div>
          )}

          <dl className="kv">
            <dt>Customer</dt>
            <dd>
              {can('gops.customers.view_all') ? (
                <Link to={`/g-ops/customers/${visit.customer.id}`}>{visit.customer.name}</Link>
              ) : (
                visit.customer.name
              )}
              {visit.site && <span className="faint"> · {visit.site.name}</span>}
            </dd>
            <dt>Machine</dt>
            <dd>
              {visit.asset ? (
                can('gops.installed_base.view_all') ? (
                  <Link to={`/g-ops/installed-base/${visit.asset.id}`}>{visit.asset.name}</Link>
                ) : (
                  visit.asset.name
                )
              ) : (
                <span className="faint">not named</span>
              )}
            </dd>
            <dt>Booked by</dt>
            <dd>
              {visit.contract ? (
                <>
                  <Link to={`/g-ops/service-contracts/${visit.contract.id}`} className="mono">
                    {visit.contract.number}
                  </Link>
                  {visit.sequence
                    ? ` · visit ${visit.sequence} of ${visit.contract.plannedVisits}`
                    : ' · a call-out under the contract'}
                  <span className="faint"> · {visit.contract.job.number}</span>
                </>
              ) : null}
              {visit.jobOrder && (
                <>
                  {visit.contract ? ' · ' : ''}
                  job order{' '}
                  <Link to={`/g-ops/job-orders/${visit.jobOrder.id}`} className="mono">
                    {visit.jobOrder.number}
                  </Link>
                </>
              )}
              {!visit.contract && !visit.jobOrder && <span className="faint">an unscheduled call-out</span>}
            </dd>
            {!editable && (
              <>
                <dt>Due</dt>
                <dd>{formatDate(visit.dueDate)}</dd>
              </>
            )}
            {visit.performedAt && (
              <>
                <dt>Performed</dt>
                <dd>{formatDate(visit.performedAt)}</dd>
              </>
            )}
            {!editable && (
              <>
                <dt>Engineer</dt>
                <dd>{visit.assignedTo?.name ?? <span className="faint">unassigned</span>}</dd>
                <dt>Notes</dt>
                <dd>{visit.notes ?? <span className="faint">none</span>}</dd>
              </>
            )}
          </dl>

          {formOpen && (
            <>
              <div className="grid grid-2">
                <Field label={visit.status === 'MISSED' ? 'New date' : 'Due'}>
                  <input
                    type="date"
                    value={form.dueDate}
                    onChange={(e) => setForm({ ...form, dueDate: e.target.value })}
                  />
                </Field>
                <Field label="Engineer" htmlFor={engineerId}>
                  <PersonSelect
                    id={engineerId}
                    value={form.assignedToId}
                    onChange={(id) => setForm((f) => ({ ...f, assignedToId: id }))}
                    people={engineers}
                    placeholder="— unassigned —"
                    current={visit.assignedTo}
                  />
                </Field>
              </div>
              <Field label="Notes for the engineer">
                <textarea rows={2} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
              </Field>
            </>
          )}

          {canRestore && <div className="alert info">This visit was cancelled.</div>}
          {visit.status === 'CANCELLED' && visit.notes && <p className="faint svc-notes">{visit.notes}</p>}
        </>
      )}
    </Modal>
  );
}

// ── A call-out nobody scheduled ─────────────────────────────────────────────

function NewVisitModal({ onClose, onCreated }: { onClose: () => void; onCreated: (id: string) => void }) {
  const { can } = useAuth();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [customer, setCustomer] = useState<CustomerRef | null>(null);
  const [sites, setSites] = useState<{ id: string; name: string }[]>([]);
  const [assets, setAssets] = useState<{ id: string; name: string; serialNo: string | null; siteId: string | null }[]>([]);
  const [contracts, setContracts] = useState<{ id: string; number: string; job: { name: string } }[]>([]);
  const { people: engineers } = usePeople('gops.pm_reports.create');
  const ids = useId();
  const [form, setForm] = useState({
    kind: 'CORRECTIVE',
    customerId: '',
    siteId: '',
    assetId: '',
    contractId: '',
    dueDate: todayLocal(),
    assignedToId: '',
    notes: '',
  });

  useEffect(() => {
    if (!form.customerId) {
      setSites([]);
      setAssets([]);
      setContracts([]);
      return;
    }
    api
      .get<{ sites: { id: string; name: string }[] }>(`/customers/${form.customerId}`)
      .then((c) => setSites(c.sites ?? []))
      .catch(() => setSites([]));
    if (can('gops.installed_base.view_all')) {
      api
        .get<{ rows: typeof assets }>(`/installed-assets${qs({ pageSize: 200, customerId: form.customerId })}`)
        .then((d) => setAssets(d.rows))
        .catch(() => setAssets([]));
    }
    api
      .get<{ rows: typeof contracts }>(`/service-contracts${qs({ pageSize: 200, status: 'ACTIVE', customerId: form.customerId })}`)
      .then((d) => setContracts(d.rows))
      .catch(() => setContracts([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form.customerId]);

  async function create() {
    setBusy(true);
    setError(null);
    try {
      const created = await api.post<{ id: string; number: string }>('/service-visits', {
        kind: form.kind,
        customerId: form.customerId,
        siteId: form.siteId || null,
        assetId: form.assetId || null,
        contractId: form.contractId || null,
        dueDate: form.dueDate,
        assignedToId: form.assignedToId || null,
        notes: form.notes || null,
      });
      toast('ok', `${created.number} booked`);
      onCreated(created.id);
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  }

  return (
    <Modal
      title="New call-out"
      onClose={onClose}
      footer={
        <ModalFoot onCancel={onClose} busy={busy}>
          <button
            type="button"
            className="btn btn-primary"
            onClick={create}
            disabled={busy || !form.customerId || !form.dueDate}
          >
            {busy ? 'Booking…' : 'Book visit'}
          </button>
        </ModalFoot>
      }
    >
      <ErrorBox error={error} />
      <div className="grid grid-2">
        <Field label="Kind">
          <select value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value })}>
            {KINDS.map((k) => (
              <option key={k.value} value={k.value}>
                {k.label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Due">
          <input type="date" value={form.dueDate} onChange={(e) => setForm({ ...form, dueDate: e.target.value })} />
        </Field>
      </div>
      <Field label="Customer" htmlFor={`${ids}-customer`}>
        <CustomerPicker
          inputId={`${ids}-customer`}
          value={customer}
          onError={setError}
          onChange={(c) => {
            setCustomer(c);
            setForm((f) =>
              (c?.id ?? '') === f.customerId ? f : { ...f, customerId: c?.id ?? '', siteId: '', assetId: '', contractId: '' },
            );
          }}
        />
      </Field>
      <div className="grid grid-2">
        <Field label="Site">
          <select value={form.siteId} onChange={(e) => setForm({ ...form, siteId: e.target.value })}>
            <option value="">— none —</option>
            {sites.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Machine">
          <select
            value={form.assetId}
            onChange={(e) => {
              const a = assets.find((x) => x.id === e.target.value);
              setForm({ ...form, assetId: e.target.value, siteId: a?.siteId ?? form.siteId });
            }}
          >
            <option value="">— none —</option>
            {assets.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
                {a.serialNo ? ` (${a.serialNo})` : ''}
              </option>
            ))}
          </select>
        </Field>
      </div>
      {contracts.length > 0 && (
        <Field label="Under contract" hint="A call-out under a contract is covered work, and is kept when the schedule is regenerated">
          <select value={form.contractId} onChange={(e) => setForm({ ...form, contractId: e.target.value })}>
            <option value="">— not under a contract —</option>
            {contracts.map((c) => (
              <option key={c.id} value={c.id}>
                {c.number} — {c.job.name}
              </option>
            ))}
          </select>
        </Field>
      )}
      <Field label="Engineer" htmlFor={`${ids}-engineer`}>
        <PersonSelect
          id={`${ids}-engineer`}
          value={form.assignedToId}
          onChange={(id) => setForm((f) => ({ ...f, assignedToId: id }))}
          people={engineers}
          placeholder="— unassigned —"
        />
      </Field>
      <Field label="Notes for the engineer">
        <textarea rows={2} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
      </Field>
    </Modal>
  );
}
