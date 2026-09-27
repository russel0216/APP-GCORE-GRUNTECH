import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { DataList, type Column } from '../../components/DataList';
import { Stat } from '../../components/charts';
import {
  ErrorBox,
  Field,
  Loading,
  Modal,
  StatusBadge,
  formatDate,
  formatMoney,
  useToast,
  type Tone,
} from '../../components/ui';
import type { Asset } from './InstalledBase';
import { monthOf, todayLocal } from '../../lib/day';
import { VisitBadge } from './Schedule';

/**
 * Service contracts.
 *
 * A contract is a **Job of type SERVICE_CONTRACT** — it has its own costing,
 * its own budget across the same five cost categories, its own schedule of
 * values and its own progress billing (model §4.5). This screen holds only
 * what a job cannot: which equipment is covered, how often it is visited, and
 * when it runs out.
 */

const STATUSES = [
  { value: 'DRAFT', label: 'Draft' },
  { value: 'ACTIVE', label: 'Active' },
  { value: 'EXPIRED', label: 'Expired' },
  { value: 'RENEWED', label: 'Renewed' },
  { value: 'CANCELLED', label: 'Cancelled' },
];

/** RENEWED reads as information here, not as a settled-well outcome. */
const CONTRACT_TONES: Record<string, Tone> = { RENEWED: 'info' };

interface Contract {
  id: string;
  number: string;
  status: string;
  startsAt: string;
  endsAt: string;
  frequencyMonths: number;
  plannedVisits: number;
  responseTime: string | null;
  exclusions: string | null;
  coverageNotes: string | null;
  expiry: string;
  daysRemaining: number | null;
  job: {
    id: string;
    number: string;
    name: string;
    status: string;
    contractValue: number;
    customer: { id: string; code: string; name: string };
    site: { id: string; name: string } | null;
    projectManager: { id: string; name: string } | null;
    /** The costing a renewal starts from. */
    costing: { id: string } | null;
  };
  assets: { id: string; code: string; name: string; serialNo: string | null }[];
}

interface UnconfiguredJob {
  id: string;
  number: string;
  name: string;
  contractValue: number;
  customer: { id: string; name: string };
  site: { id: string; name: string } | null;
}

export function ServiceContracts() {
  const { can } = useAuth();
  const navigate = useNavigate();
  const [queue, setQueue] = useState<UnconfiguredJob[] | null>(null);
  const [configuring, setConfiguring] = useState<UnconfiguredJob | null>(null);
  const [reload, setReload] = useState(0);

  const loadQueue = useCallback(async () => {
    try {
      setQueue(await api.get<UnconfiguredJob[]>('/service-contracts/queue/unconfigured'));
    } catch {
      setQueue([]);
    }
  }, []);

  useEffect(() => {
    loadQueue();
  }, [loadQueue, reload]);

  const columns: Column<Contract>[] = [
    {
      key: 'number',
      label: 'Number',
      sortKey: 'number',
      width: '150px',
      render: (r) => <span className="mono">{r.number}</span>,
    },
    {
      key: 'customer',
      label: 'Customer',
      render: (r) => (
        <div>
          <div>{r.job.customer.name}</div>
          <div className="faint">
            {r.job.name}
            {r.job.site && ` · ${r.job.site.name}`}
          </div>
        </div>
      ),
    },
    {
      key: 'term',
      label: 'Term',
      sortKey: 'endsAt',
      render: (r) => (
        <div>
          <div>
            {formatDate(r.startsAt)} → {formatDate(r.endsAt)}
          </div>
          {r.status === 'ACTIVE' && r.daysRemaining !== null && (
            <div className={`faint ${r.expiry === 'EXPIRING' ? 'warn' : ''}`}>
              {r.daysRemaining < 0 ? 'lapsed' : `${r.daysRemaining} days left`}
            </div>
          )}
        </div>
      ),
    },
    {
      key: 'assets',
      label: 'Covers',
      align: 'right',
      render: (r) => `${r.assets.length} machine${r.assets.length === 1 ? '' : 's'}`,
    },
    {
      key: 'frequency',
      label: 'Visits',
      align: 'right',
      render: (r) => (
        <div>
          <div className="mono">{r.plannedVisits}</div>
          <div className="faint">every {r.frequencyMonths}m</div>
        </div>
      ),
    },
    {
      key: 'value',
      label: 'Value',
      align: 'right',
      render: (r) => <span className="mono">{formatMoney(r.job.contractValue)}</span>,
    },
    {
      key: 'status',
      label: 'Status',
      render: (r) => <StatusBadge status={r.status} extra={CONTRACT_TONES} />,
    },
  ];

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Service Contracts</h1>
          <p>
            A contract is a job of its own type, so it carries a costing, a budget and its own
            billing. What lives here is the cover: which machines, how often, and until when.
          </p>
        </div>
      </div>

      {queue && queue.length > 0 && (
        <div className="card">
          <h3 className="card-title">
            {queue.length} service job{queue.length === 1 ? '' : 's'} with no coverage terms yet
          </h3>
          <p className="muted">
            The commercial side is set up. Say what is covered and how often, and the PM schedule
            writes itself.
          </p>
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Job</th>
                  <th>Customer</th>
                  <th className="right">Value</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {queue.map((j) => (
                  <tr key={j.id}>
                    <td>
                      <span className="mono">{j.number}</span>
                      <div className="faint">{j.name}</div>
                    </td>
                    <td>
                      {j.customer.name}
                      {j.site && <div className="faint">{j.site.name}</div>}
                    </td>
                    <td className="right mono">{formatMoney(j.contractValue)}</td>
                    <td className="right">
                      {can('gops.service_contracts.create') && (
                        <button className="btn btn-sm btn-primary" onClick={() => setConfiguring(j)}>
                          Set cover
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <DataList<Contract>
        listKey="service-contracts"
        endpoint="/service-contracts"
        columns={columns}
        rowKey={(r) => r.id}
        scoped
        reloadToken={reload}
        searchPlaceholder="Search number, customer, job…"
        emptyTitle="No service contracts yet"
        onRowClick={(r) => navigate(`/g-ops/service-contracts/${r.id}`)}
        filters={[
          { key: 'status', label: 'Status', options: STATUSES },
          { key: 'expiring', label: 'Renewal', options: [{ value: 'true', label: 'Expiring soon' }] },
        ]}
      />

      {configuring && (
        <CoverModal
          job={configuring}
          onClose={() => setConfiguring(null)}
          onSaved={(id) => {
            setConfiguring(null);
            setReload((r) => r + 1);
            navigate(`/g-ops/service-contracts/${id}`);
          }}
        />
      )}
    </div>
  );
}

function CoverModal({
  job,
  onClose,
  onSaved,
}: {
  job: UnconfiguredJob;
  onClose: () => void;
  onSaved: (id: string) => void;
}) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [assets, setAssets] = useState<Asset[]>([]);
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [settings, setSettings] = useState<{ defaultFrequencyMonths: number } | null>(null);

  const today = todayLocal();
  const oneYear = (() => {
    const d = new Date(`${today}T00:00:00Z`);
    d.setUTCFullYear(d.getUTCFullYear() + 1);
    d.setUTCDate(d.getUTCDate() - 1);
    return d.toISOString().slice(0, 10);
  })();

  const [form, setForm] = useState({
    startsAt: today,
    endsAt: oneYear,
    frequencyMonths: 3,
    responseTime: '',
    exclusions: '',
    coverageNotes: '',
  });

  useEffect(() => {
    api
      .get<{ rows: Asset[] }>(`/installed-assets?pageSize=200&customerId=${job.customer.id}&status=ACTIVE`)
      .then((d) => setAssets(d.rows))
      .catch(() => {});
    api
      .get<{ defaultFrequencyMonths: number }>('/aftermarket/settings')
      .then((s) => {
        setSettings(s);
        setForm((f) => ({ ...f, frequencyMonths: s.defaultFrequencyMonths }));
      })
      .catch(() => {});
  }, [job.customer.id]);

  // The same arithmetic the server will do, so the count is not a surprise.
  const plannedCount = (() => {
    if (!form.startsAt || !form.endsAt || form.frequencyMonths < 1) return 0;
    const start = new Date(`${form.startsAt}T00:00:00Z`);
    const end = new Date(`${form.endsAt}T00:00:00Z`);
    let n = 0;
    for (let i = 1; i <= 240; i++) {
      const d = new Date(start);
      const day = d.getUTCDate();
      d.setUTCDate(1);
      d.setUTCMonth(d.getUTCMonth() + form.frequencyMonths * i);
      const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
      d.setUTCDate(Math.min(day, last));
      if (d > end) break;
      n++;
    }
    return n;
  })();

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const created = await api.post<{ id: string }>('/service-contracts', {
        jobId: job.id,
        startsAt: form.startsAt,
        endsAt: form.endsAt,
        frequencyMonths: form.frequencyMonths,
        responseTime: form.responseTime || null,
        exclusions: form.exclusions || null,
        coverageNotes: form.coverageNotes || null,
        assetIds: [...chosen],
      });
      toast('ok', 'Cover set — activate it to write the schedule');
      onSaved(created.id);
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  }

  return (
    <Modal
      title={`Coverage for ${job.number}`}
      onClose={onClose}
      wide
      footer={
        <>
          <button className="btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button className="btn btn-primary" onClick={save} disabled={busy || chosen.size === 0}>
            {busy ? 'Saving…' : 'Set cover'}
          </button>
        </>
      }
    >
      <ErrorBox error={error} />

      <div className="grid grid-3">
        <Field label="Cover starts">
          <input
            type="date"
            value={form.startsAt}
            onChange={(e) => setForm({ ...form, startsAt: e.target.value })}
          />
        </Field>
        <Field label="Cover ends">
          <input
            type="date"
            value={form.endsAt}
            onChange={(e) => setForm({ ...form, endsAt: e.target.value })}
          />
        </Field>
        <Field label="Visit every (months)" hint={settings ? `${plannedCount} visits planned` : undefined}>
          <input
            type="number"
            min={1}
            max={24}
            value={form.frequencyMonths}
            onChange={(e) => setForm({ ...form, frequencyMonths: Number(e.target.value) })}
          />
        </Field>
      </div>

      <div className="alert info">
        The first visit falls one interval after cover starts, not on the day it begins — there is
        nothing to maintain on day one. A visit that would fall after the end date is dropped
        rather than squeezed in.
      </div>

      <div className="grid grid-2">
        <Field label="Response time promised" hint='Free text — "next working day" is as common as a number'>
          <input
            value={form.responseTime}
            onChange={(e) => setForm({ ...form, responseTime: e.target.value })}
          />
        </Field>
        <Field label="What the contract excludes" hint="Consumables, parts, travel…">
          <input
            value={form.exclusions}
            onChange={(e) => setForm({ ...form, exclusions: e.target.value })}
          />
        </Field>
      </div>

      <h4 className="svc-subhead">
        What is covered — {chosen.size} of {assets.length} selected
      </h4>
      {assets.length === 0 ? (
        <div className="alert warn">
          Nothing is registered against {job.customer.name} in the installed base. Register the
          equipment first — a contract covering nothing cannot be scheduled.
        </div>
      ) : (
        <div className="table-wrap svc-scroll">
          <table className="data">
            <tbody>
              {assets.map((a) => (
                <tr key={a.id}>
                  <td>
                    {/* A real checkbox in a label: the row used to take the
                        click and the box was read-only, so no keyboard could
                        choose anything. */}
                    <label className="svc-pick">
                      <input
                        type="checkbox"
                        checked={chosen.has(a.id)}
                        onChange={() => {
                          const next = new Set(chosen);
                          if (next.has(a.id)) next.delete(a.id);
                          else next.add(a.id);
                          setChosen(next);
                        }}
                      />
                      <span>
                        <span className="svc-pick-name">{a.name}</span>
                        <span className="faint mono">
                          {a.code}
                          {a.serialNo && ` · ${a.serialNo}`}
                        </span>
                      </span>
                    </label>
                  </td>
                  <td className="right faint">{a.site?.name ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Modal>
  );
}

// ── One contract ─────────────────────────────────────────────────────────────

interface ContractDetail extends Contract {
  visits: {
    id: string;
    number: string;
    kind: string;
    status: string;
    sequence: number | null;
    dueDate: string;
    performedAt: string | null;
    assignedTo: { id: string; name: string } | null;
    report: { id: string; number: string; status: string } | null;
    jobOrder: { id: string; number: string; status: string } | null;
  }[];
  renewedFrom: { id: string; number: string; endsAt: string } | null;
  renewedTo: { id: string; number: string; startsAt: string } | null;
  progress: { planned: number; completed: number; missed: number; remaining: number };
}

export function ContractDetail() {
  const { id } = useParams<{ id: string }>();
  const toast = useToast();
  const navigate = useNavigate();
  const { can } = useAuth();
  const [row, setRow] = useState<ContractDetail | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setRow(await api.get<ContractDetail>(`/service-contracts/${id}`));
    } catch (err) {
      setError(err);
    }
  }, [id]);

  useEffect(() => {
    load();
  }, [load]);

  if (error) return <ErrorBox error={error} />;
  if (!row) return <Loading />;

  async function run(path: string, message: string) {
    setBusy(true);
    setError(null);
    try {
      const result = await api.post<{ created: number; kept: number }>(`/service-contracts/${id}/${path}`);
      toast('ok', `${message} — ${result.created} visit(s) scheduled`);
      await load();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  /**
   * Renewal is two deliberate steps (model §4.5): copy last year's costing,
   * reprice it, then build the new contract on the copy. The copy carries
   * `?renewFrom=` so the costing page says what it is renewing and the new
   * contract links back to this one.
   */
  async function renew() {
    if (!row?.job.costing) return;
    setBusy(true);
    setError(null);
    try {
      const copy = await api.post<{ id: string; number: string }>(`/costings/${row.job.costing.id}/duplicate`, {});
      toast('ok', `${copy.number} copied at last year's prices — reprice it`);
      navigate(`/g-ops/costing/${copy.id}?renewFrom=${row.id}`);
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  }

  const today = todayLocal();
  const nextDue = row.visits.find((v) => v.status === 'SCHEDULED' && v.dueDate.slice(0, 10) >= today);
  const calendarHref = `/g-ops/visits?contractId=${row.id}&month=${monthOf(nextDue ? nextDue.dueDate.slice(0, 10) : today)}`;
  const canRenew =
    !row.renewedTo &&
    (row.expiry === 'EXPIRING' || row.expiry === 'EXPIRED' || row.status === 'EXPIRED') &&
    row.status !== 'DRAFT' &&
    row.status !== 'CANCELLED' &&
    !!row.job.costing &&
    can('gops.costing.create');

  return (
    <div>

      <div className="page-head">
        <div>
          <h1>
            <span className="mono">{row.number}</span>{' '}
            <StatusBadge status={row.status} extra={CONTRACT_TONES} />
          </h1>
          <p>
            {can('gops.customers.view_all') ? (
              <Link to={`/g-ops/customers/${row.job.customer.id}`}>{row.job.customer.name}</Link>
            ) : (
              row.job.customer.name
            )}{' '}
            ·{' '}
            <Link to={`/g-ops/projects/${row.job.id}`} className="mono">
              {row.job.number}
            </Link>{' '}
            — {row.job.name}
          </p>
        </div>
        <div className="row">
          {row.status === 'DRAFT' && can('gops.service_contracts.edit_all') && (
            <button
              className="btn btn-primary btn-sm"
              onClick={() => run('activate', 'Contract activated')}
              disabled={busy}
            >
              Activate and schedule
            </button>
          )}
          {row.status === 'ACTIVE' && can('gops.service_contracts.edit_all') && (
            <button
              className="btn btn-sm"
              onClick={() => run('regenerate-schedule', 'Schedule regenerated')}
              disabled={busy}
            >
              Regenerate schedule
            </button>
          )}
          {canRenew && (
            <button className="btn btn-primary btn-sm" onClick={renew} disabled={busy}>
              Renew
            </button>
          )}
        </div>
      </div>

      {row.renewedFrom && (
        <div className="alert info">
          Renewal of{' '}
          <Link to={`/g-ops/service-contracts/${row.renewedFrom.id}`} className="mono">
            {row.renewedFrom.number}
          </Link>
          , which ended {formatDate(row.renewedFrom.endsAt)}.
        </div>
      )}

      {row.expiry === 'EXPIRING' && row.status === 'ACTIVE' && (
        <div className="alert warn">
          This contract ends in {row.daysRemaining} days. Renew it now — cover that lapses is cover
          somebody has to sell again from scratch.
          {!canRenew && !can('gops.costing.create') && ' Whoever prices service work starts the renewal from here.'}
        </div>
      )}
      {row.renewedTo && (
        <div className="alert ok">
          Renewed as{' '}
          <Link to={`/g-ops/service-contracts/${row.renewedTo.id}`} className="mono">
            {row.renewedTo.number}
          </Link>
          , starting {formatDate(row.renewedTo.startsAt)}.
        </div>
      )}

      <div className="kpi-grid svc-kpis">
        <Stat label="Planned" value={row.progress.planned} hint={`every ${row.frequencyMonths} month(s)`} />
        <Stat
          label="Completed"
          value={row.progress.completed}
          hint="report approved"
          accent={row.progress.completed > 0 ? 'neon' : undefined}
        />
        <Stat label="Remaining" value={row.progress.remaining} hint="still to visit" />
        <Stat
          label="Missed"
          value={row.progress.missed}
          hint={row.progress.missed > 0 ? 'nobody reported them in time' : 'none'}
          accent={row.progress.missed > 0 ? 'danger' : undefined}
        />
      </div>

      <div className="grid grid-2">
        <div className="card">
          <h3 className="card-title">The cover</h3>
          <dl className="kv">
            <dt>Term</dt>
            <dd>
              {formatDate(row.startsAt)} → {formatDate(row.endsAt)}
            </dd>
            <dt>Frequency</dt>
            <dd>every {row.frequencyMonths} month(s)</dd>
            <dt>Contract value</dt>
            <dd className="mono">{formatMoney(row.job.contractValue)}</dd>
            <dt>Response time</dt>
            <dd>{row.responseTime ?? <span className="faint">not stated</span>}</dd>
            <dt>Excludes</dt>
            <dd>{row.exclusions ?? <span className="faint">nothing stated</span>}</dd>
            {row.coverageNotes && (
              <>
                <dt>Notes</dt>
                <dd>{row.coverageNotes}</dd>
              </>
            )}
          </dl>
        </div>

        <div className="card">
          <h3 className="card-title">Equipment covered ({row.assets.length})</h3>
          {row.assets.length === 0 ? (
            <p className="muted">
              Nothing is covered. A schedule against nothing would send engineers to look at air.
            </p>
          ) : (
            <div className="stack">
              {row.assets.map((a) => (
                <div key={a.id}>
                  <Link to={`/g-ops/installed-base/${a.id}`}>{a.name}</Link>
                  <div className="faint mono">
                    {a.code}
                    {a.serialNo && ` · ${a.serialNo}`}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="card">
        <div className="panel-head">
          <h3 className="card-title">The PM schedule</h3>
          {row.visits.length > 0 && <Link to={calendarHref}>Open in calendar</Link>}
        </div>
        {row.visits.length === 0 ? (
          <p className="muted">
            No schedule yet. Activating the contract writes it.
          </p>
        ) : (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Visit</th>
                  <th>Due</th>
                  <th>Engineer</th>
                  <th>Performed</th>
                  <th>Report</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {row.visits.map((v) => (
                  <tr key={v.id}>
                    <td>
                      <Link to={`/g-ops/visits?visit=${v.id}`} className="mono">
                        {v.number}
                      </Link>
                      {v.sequence ? (
                        <div className="faint">visit {v.sequence}</div>
                      ) : v.jobOrder ? (
                        <div className="faint">
                          job order{' '}
                          <Link to={`/g-ops/job-orders/${v.jobOrder.id}`} className="mono">
                            {v.jobOrder.number}
                          </Link>
                        </div>
                      ) : (
                        <div className="faint">call-out</div>
                      )}
                    </td>
                    <td>{formatDate(v.dueDate)}</td>
                    <td className="faint">{v.assignedTo?.name ?? 'unassigned'}</td>
                    <td className="faint">{v.performedAt ? formatDate(v.performedAt) : '—'}</td>
                    <td>
                      {v.report ? (
                        <Link to={`/g-ops/service-reports/${v.report.id}`} className="mono">
                          {v.report.number}
                        </Link>
                      ) : (
                        <span className="faint">—</span>
                      )}
                    </td>
                    <td>
                      <VisitBadge
                        visit={{ status: v.status, overdue: v.status === 'SCHEDULED' && v.dueDate.slice(0, 10) < today }}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="faint svc-footnote">
          Regenerating the schedule rewrites only the generated visits nobody has attended. A
          completed or missed visit is a record of what happened, and a call-out — booked by hand
          or by a job order — is not part of the plan; neither is ever erased.
        </p>
      </div>
    </div>
  );
}
