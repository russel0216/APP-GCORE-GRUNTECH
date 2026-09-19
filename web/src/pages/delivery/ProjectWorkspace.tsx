import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, getToken } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import {
  Empty,
  ErrorBox,
  Field,
  Loading,
  Modal,
  formatDate,
  formatDateTime,
  formatMoney,
  useToast,
} from '../../components/ui';
import { SCurve, type CurvePoint } from './SCurve';
import { JOB_STATUSES, ProgressBar, jobStatusTone } from './Projects';

/**
 * The project workspace (model §8.1).
 *
 * One record, one page, tabs across it — rather than sending someone back to a
 * menu to find this project's purchase requests. Overview · Budget · Scope ·
 * Progress · Billing · Plans · Tasks · Activity.
 */

interface Position {
  costCategoryId: string;
  code: string;
  name: string;
  budgeted: number;
  committed: number;
  incurred: number;
  consumed: number;
  available: number;
  usedPct: number;
}

interface ScopeItem {
  id: string;
  kind: string;
  name: string;
  description: string | null;
  value: number;
  durationDays: number;
  plannedStart: string | null;
  plannedEnd: string | null;
  sortOrder: number;
}

interface Job {
  id: string;
  number: string;
  type: string;
  status: string;
  name: string;
  contractValue: number;
  customerPoNumber: string | null;
  customerPoDate: string | null;
  contractDate: string | null;
  startDate: string | null;
  targetEndDate: string | null;
  actualEndDate: string | null;
  notes: string | null;
  downpaymentPct: number | null;
  retentionPct: number | null;
  customer: { id: string; code: string; name: string };
  site: { id: string; name: string; address: string | null; city: string | null } | null;
  contact: { id: string; name: string } | null;
  projectManager: { id: string; name: string } | null;
  createdBy: { id: string; name: string };
  costing: { id: string; number: string; title: string; totalCost: number; contractValue: number } | null;
  quotationRevision: {
    id: string;
    revision: number;
    quotation: { id: string; number: string; subject: string };
  } | null;
  scopeItems: ScopeItem[];
  progressReports: {
    id: string;
    number: string;
    reportNo: number;
    status: string;
    periodFrom: string;
    periodTo: string;
  }[];
  billings: {
    id: string;
    number: string;
    billingNo: number;
    status: string;
    billingDate: string;
    grossAmount: number;
    netCollectible: number;
  }[];
  plans: {
    id: string;
    title: string;
    drawingNo: string | null;
    revision: string;
    discipline: string | null;
    status: string;
    approvedAt: string | null;
    approvedBy: string | null;
    createdAt: string;
  }[];
  tasks: {
    id: string;
    name: string;
    status: string;
    progressPct: number;
    dueDate: string | null;
    assignedTo: { id: string; name: string } | null;
  }[];
  budgetRequestCount: number;
  position: Position[];
  curve: CurvePoint[];
  summary: {
    contractValue: number;
    budgeted: number;
    committed: number;
    incurred: number;
    available: number;
    actualCost: number;
    expectedProfit: number;
    expectedMarginPct: number;
    costUsedPct: number;
    grossProfit: number;
    grossMarginPct: number;
    progressPct: number;
    earnedValue: number;
    billed: number;
    unbilled: number;
    billedPct: number;
  };
}

type Tab = 'overview' | 'budget' | 'scope' | 'progress' | 'billing' | 'plans' | 'tasks' | 'activity';

export function ProjectWorkspace() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { can } = useAuth();
  const toast = useToast();

  const [job, setJob] = useState<Job | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [tab, setTab] = useState<Tab>('overview');
  const [editing, setEditing] = useState(false);
  const [budgetRequest, setBudgetRequest] = useState(false);
  const [newReport, setNewReport] = useState(false);
  const [newPlan, setNewPlan] = useState(false);
  const [activity, setActivity] = useState<
    { id: string; action: string; summary: string | null; actorName: string | null; at: string }[]
  >([]);

  const load = useCallback(async () => {
    if (!id) return;
    try {
      setJob(await api.get<Job>(`/jobs/${id}`));
      setError(null);
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (tab !== 'activity' || !id) return;
    api.get<typeof activity>(`/audit/job/${id}`).then(setActivity).catch(() => setActivity([]));
  }, [tab, id]);

  if (loading) return <Loading />;
  if (!job) return <ErrorBox error={error ?? new Error('Project not found')} />;

  const s = job.summary;
  const mayEdit = can('gops.projects.edit_all');

  async function setStatus(status: string) {
    if (!job) return;
    try {
      await api.patch(`/jobs/${job.id}`, { status });
      toast('ok', `Moved to ${JOB_STATUSES.find((x) => x.value === status)?.label}`);
      await load();
    } catch (err) {
      setError(err);
    }
  }

  return (
    <div>
      <div className="breadcrumb">
        {job.quotationRevision && (
          <>
            <Link to={`/g-ops/quotations/${job.quotationRevision.quotation.id}`}>
              {job.quotationRevision.quotation.number} R{job.quotationRevision.revision}
            </Link>
            <span className="sep">›</span>
          </>
        )}
        {job.costing && (
          <>
            <Link to={`/g-ops/costing/${job.costing.id}`}>{job.costing.number}</Link>
            <span className="sep">›</span>
          </>
        )}
        <Link to="/g-ops/projects">Projects</Link>
        <span className="sep">›</span>
        <span className="mono">{job.number}</span>
      </div>

      <div className="page-head">
        <div>
          <h1>{job.name}</h1>
          <p>
            <Link to={`/g-ops/customers/${job.customer.id}`}>{job.customer.name}</Link>
            {job.site ? ` · ${job.site.name}` : ''}
            {job.projectManager ? ` · ${job.projectManager.name}` : ' · unassigned'}
            <span className={`badge ${jobStatusTone(job.status)}`} style={{ marginLeft: 8 }}>
              {JOB_STATUSES.find((x) => x.value === job.status)?.label}
            </span>
          </p>
        </div>
        {mayEdit && (
          <div className="row">
            <button className="btn" onClick={() => setEditing(true)}>
              Edit
            </button>
            {job.status === 'PLANNING' && (
              <button className="btn btn-ok" onClick={() => setStatus('IN_PROGRESS')}>
                Start
              </button>
            )}
            {job.status === 'IN_PROGRESS' && (
              <button className="btn" onClick={() => setStatus('COMPLETED')}>
                Mark complete
              </button>
            )}
          </div>
        )}
      </div>

      <ErrorBox error={error} />

      {/* The numbers a project manager actually opens this page for. */}
      <div className="grid grid-4" style={{ marginBottom: 18 }}>
        <Stat label="Contract value" value={formatMoney(s.contractValue)} accent />
        <Stat
          label="Progress"
          value={<ProgressBar pct={s.progressPct} />}
          sub={`${formatMoney(s.earnedValue)} earned`}
        />
        <Stat
          label="Billed"
          value={formatMoney(s.billed)}
          sub={`${s.billedPct.toFixed(1)}% of contract`}
        />
        <Stat
          label="Unbilled work"
          value={formatMoney(s.unbilled)}
          sub="done but not invoiced"
          tone={s.unbilled > 0 ? 'warn' : undefined}
        />
      </div>

      <div className="grid grid-4" style={{ marginBottom: 18 }}>
        <Stat label="Budget" value={formatMoney(s.budgeted)} />
        <Stat
          label="Committed + incurred"
          value={formatMoney(s.actualCost)}
          sub={s.budgeted > 0 ? `${s.costUsedPct.toFixed(1)}% of budget` : undefined}
        />
        <Stat
          label="Available"
          value={formatMoney(s.available)}
          tone={s.available < 0 ? 'danger' : undefined}
        />
        {/* Expected margin, not margin-so-far. A job that has spent nothing
            would otherwise read 100%, which is true and useless. */}
        <Stat
          label="Expected margin"
          value={
            <span
              className={`badge ${s.expectedMarginPct < 0 ? 'danger' : s.expectedMarginPct < 10 ? 'warn' : 'ok'}`}
            >
              {s.expectedMarginPct.toFixed(1)}%
            </span>
          }
          sub={`${formatMoney(s.expectedProfit)} if delivered to budget`}
        />
      </div>

      {s.costUsedPct > 0 && s.progressPct > 0 && (
        <div className={`alert ${s.costUsedPct > s.progressPct + 10 ? 'error' : 'info'}`}>
          {s.costUsedPct.toFixed(1)}% of the budget is spent or committed against{' '}
          {s.progressPct.toFixed(1)}% of the work done.
          {s.costUsedPct > s.progressPct + 10
            ? ' Cost is running ahead of progress — the margin is eroding.'
            : ' Cost is tracking progress.'}
        </div>
      )}

      {s.available < 0 && (
        <div className="alert error">
          This project is committed beyond its budget by {formatMoney(Math.abs(s.available))}. Raise
          a budget request, or the next purchase request will be blocked.
        </div>
      )}

      <div className="scope-switch" style={{ marginBottom: 16, flexWrap: 'wrap' }}>
        {([
          ['overview', 'Overview'],
          ['budget', `Budget (${job.position.filter((p) => p.budgeted > 0).length})`],
          ['scope', `Scope (${job.scopeItems.length})`],
          ['progress', `Progress (${job.progressReports.length})`],
          ['billing', `Billing (${job.billings.length})`],
          ['plans', `Plans (${job.plans.length})`],
          ['tasks', `Tasks (${job.tasks.length})`],
          ['activity', 'Activity'],
        ] as [Tab, string][]).map(([key, label]) => (
          <button key={key} className={tab === key ? 'active' : ''} onClick={() => setTab(key)}>
            {label}
          </button>
        ))}
      </div>

      {tab === 'overview' && (
        <div className="grid grid-2">
          <div className="card" style={{ gridColumn: '1 / -1' }}>
            <h3 className="card-title">S-curve — planned vs actual vs billed</h3>
            <SCurve points={job.curve} />
            <p className="faint" style={{ fontSize: 12, marginBottom: 0 }}>
              The gap between planned and actual is schedule slip. The gap between actual and
              billed is work you have done but not yet invoiced.
            </p>
          </div>

          <div className="card">
            <h3 className="card-title">Contract</h3>
            <Row label="Number" value={<span className="mono">{job.number}</span>} />
            <Row label="Type" value={job.type === 'PROJECT' ? 'Project' : 'Service contract'} />
            <Row label="Customer P.O." value={job.customerPoNumber} />
            <Row label="P.O. date" value={formatDate(job.customerPoDate)} />
            <Row label="Contract value" value={formatMoney(job.contractValue)} />
            <Row
              label="From costing"
              value={job.costing ? <Link to={`/g-ops/costing/${job.costing.id}`}>{job.costing.number}</Link> : null}
            />
            <Row label="Estimated cost" value={job.costing ? formatMoney(job.costing.totalCost) : null} />
          </div>

          <div className="card">
            <h3 className="card-title">Schedule</h3>
            <Row label="Start" value={formatDate(job.startDate)} />
            <Row label="Target end" value={formatDate(job.targetEndDate)} />
            <Row label="Actual end" value={formatDate(job.actualEndDate)} />
            <Row label="Project manager" value={job.projectManager?.name} />
            <Row label="Site" value={job.site ? [job.site.name, job.site.city].filter(Boolean).join(' — ') : null} />
            <Row label="Created by" value={job.createdBy.name} />
          </div>

          {job.notes && (
            <div className="card" style={{ gridColumn: '1 / -1' }}>
              <h3 className="card-title">Notes</h3>
              <div style={{ whiteSpace: 'pre-wrap' }}>{job.notes}</div>
            </div>
          )}
        </div>
      )}

      {tab === 'budget' && (
        <div className="card">
          <div className="row" style={{ justifyContent: 'space-between', marginBottom: 12 }}>
            <h3 className="card-title" style={{ margin: 0 }}>
              Budget monitoring
            </h3>
            {can('gops.budget_requests.create') && (
              <button className="btn btn-primary btn-sm" onClick={() => setBudgetRequest(true)}>
                + Budget request
              </button>
            )}
          </div>

          <p className="muted" style={{ marginTop: 0, fontSize: 13 }}>
            Available = budgeted − committed − incurred. Consumed is shown but not subtracted —
            stock issued to this job was already counted when it was received, and subtracting both
            would charge the same peso twice.
          </p>

          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Category</th>
                  <th className="right">Budgeted</th>
                  <th className="right">Committed</th>
                  <th className="right">Incurred</th>
                  <th className="right">Consumed</th>
                  <th className="right">Available</th>
                  <th style={{ width: 120 }}>Used</th>
                </tr>
              </thead>
              <tbody>
                {job.position.map((p) => (
                  <tr key={p.costCategoryId}>
                    <td>{p.name}</td>
                    <td className="right mono">{formatMoney(p.budgeted)}</td>
                    <td className="right mono">{p.committed ? formatMoney(p.committed) : <span className="faint">—</span>}</td>
                    <td className="right mono">{p.incurred ? formatMoney(p.incurred) : <span className="faint">—</span>}</td>
                    <td className="right mono faint">{p.consumed ? formatMoney(p.consumed) : '—'}</td>
                    <td className="right mono" style={{ color: p.available < 0 ? 'var(--danger)' : undefined }}>
                      {formatMoney(p.available)}
                    </td>
                    <td>
                      <ProgressBar
                        pct={p.usedPct}
                        tone={p.usedPct > 100 ? 'danger' : p.usedPct > 85 ? 'warn' : undefined}
                      />
                    </td>
                  </tr>
                ))}
                <tr>
                  <td>
                    <strong>TOTAL</strong>
                  </td>
                  <td className="right mono">
                    <strong>{formatMoney(s.budgeted)}</strong>
                  </td>
                  <td className="right mono">{formatMoney(s.committed)}</td>
                  <td className="right mono">{formatMoney(s.incurred)}</td>
                  <td />
                  <td className="right mono">
                    <strong>{formatMoney(s.available)}</strong>
                  </td>
                  <td />
                </tr>
              </tbody>
            </table>
          </div>

          <div className="alert info" style={{ marginTop: 14, marginBottom: 0 }}>
            Committed and incurred fill in from Phase 5 (purchase requests, orders, receiving) and
            Phase 6 (overtime posted to this project). Budget requests already move the budgeted
            column — {job.budgetRequestCount} raised so far.
          </div>
        </div>
      )}

      {tab === 'scope' && (
        <div className="card">
          <h3 className="card-title">Schedule of values</h3>
          <p className="muted" style={{ marginTop: 0, fontSize: 13 }}>
            Snapshotted from the costing when the project was created. Values are fixed — progress
            and billing are measured against them, so changing one after billing has started would
            rewrite history.
          </p>
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th style={{ width: 40 }}>#</th>
                  <th>Scope</th>
                  <th>Type</th>
                  <th className="right">Value</th>
                  <th className="right">% of contract</th>
                  <th>Planned start</th>
                  <th>Planned end</th>
                </tr>
              </thead>
              <tbody>
                {job.scopeItems.map((item, i) => (
                  <tr key={item.id}>
                    <td className="mono">{i + 1}</td>
                    <td>
                      <div>{item.name}</div>
                      {item.description && <div className="faint">{item.description}</div>}
                    </td>
                    <td className="muted">{item.kind.toLowerCase().replace(/_/g, ' ')}</td>
                    <td className="right mono">{formatMoney(item.value)}</td>
                    <td className="right mono faint">
                      {((item.value / job.contractValue) * 100).toFixed(1)}%
                    </td>
                    <td>{formatDate(item.plannedStart)}</td>
                    <td>{formatDate(item.plannedEnd)}</td>
                  </tr>
                ))}
                <tr>
                  <td colSpan={3} className="right">
                    <strong>TOTAL</strong>
                  </td>
                  <td className="right mono">
                    <strong>
                      {formatMoney(job.scopeItems.reduce((sum, i) => sum + i.value, 0))}
                    </strong>
                  </td>
                  <td colSpan={3} />
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      )}

      {tab === 'progress' && (
        <div className="card">
          <div className="row" style={{ justifyContent: 'space-between', marginBottom: 12 }}>
            <h3 className="card-title" style={{ margin: 0 }}>
              Progress reports
            </h3>
            {can('gops.progress_billing.create') && (
              <button className="btn btn-primary btn-sm" onClick={() => setNewReport(true)}>
                + New report
              </button>
            )}
          </div>

          {job.progressReports.length === 0 ? (
            <Empty
              title="No progress reports yet"
              hint="Each report carries the previous one's percentages forward, so it reads as a period statement."
            />
          ) : (
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    <th style={{ width: 50 }}>#</th>
                    <th>Number</th>
                    <th>Period</th>
                    <th>Status</th>
                    <th style={{ width: 60 }} />
                  </tr>
                </thead>
                <tbody>
                  {job.progressReports.map((r) => (
                    <tr
                      key={r.id}
                      className="clickable"
                      tabIndex={0}
                      onClick={() => navigate(`/g-ops/progress/${r.id}`)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          navigate(`/g-ops/progress/${r.id}`);
                        }
                      }}
                    >
                      <td className="mono">{r.reportNo}</td>
                      <td className="mono">{r.number}</td>
                      <td>
                        {formatDate(r.periodFrom)} — {formatDate(r.periodTo)}
                      </td>
                      <td>
                        <span className={`badge ${r.status === 'APPROVED' ? 'ok' : 'warn'}`}>
                          {r.status.toLowerCase()}
                        </span>
                      </td>
                      <td>
                        <span className="faint">open ›</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {tab === 'billing' && (
        <div className="card">
          <h3 className="card-title">Progress billings</h3>
          <p className="muted" style={{ marginTop: 0, fontSize: 13 }}>
            Raised from an approved progress report, never keyed by hand. Each billing covers only
            what has not already been billed.
          </p>
          {job.billings.length === 0 ? (
            <Empty title="Nothing billed yet" hint="Approve a progress report, then bill it." />
          ) : (
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    <th style={{ width: 50 }}>#</th>
                    <th>Number</th>
                    <th>Date</th>
                    <th className="right">Gross</th>
                    <th className="right">Net collectible</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {job.billings.map((b) => (
                    <tr
                      key={b.id}
                      className="clickable"
                      tabIndex={0}
                      onClick={() => navigate(`/g-ops/billings/${b.id}`)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          navigate(`/g-ops/billings/${b.id}`);
                        }
                      }}
                    >
                      <td className="mono">{b.billingNo}</td>
                      <td className="mono">{b.number}</td>
                      <td>{formatDate(b.billingDate)}</td>
                      <td className="right mono">{formatMoney(b.grossAmount)}</td>
                      <td className="right mono">{formatMoney(b.netCollectible)}</td>
                      <td>
                        <span className={`badge ${b.status === 'APPROVED' || b.status === 'INVOICED' ? 'ok' : 'warn'}`}>
                          {b.status.toLowerCase()}
                        </span>
                      </td>
                    </tr>
                  ))}
                  <tr>
                    <td colSpan={3} className="right">
                      <strong>TOTAL BILLED</strong>
                    </td>
                    <td className="right mono">
                      <strong>{formatMoney(s.billed)}</strong>
                    </td>
                    <td colSpan={2} />
                  </tr>
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {tab === 'plans' && (
        <div className="card">
          <div className="row" style={{ justifyContent: 'space-between', marginBottom: 12 }}>
            <h3 className="card-title" style={{ margin: 0 }}>
              Approved plans
            </h3>
            {can('gops.plans.create') && (
              <button className="btn btn-primary btn-sm" onClick={() => setNewPlan(true)}>
                + Add plan
              </button>
            )}
          </div>
          {job.plans.length === 0 ? (
            <Empty
              title="No plans registered"
              hint="Work should not start on an unapproved plan — register the drawings here."
            />
          ) : (
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    <th>Drawing</th>
                    <th>Title</th>
                    <th>Rev</th>
                    <th>Discipline</th>
                    <th>Status</th>
                    <th>Approved</th>
                    {can('gops.plans.edit_all') && <th style={{ width: 100 }} />}
                  </tr>
                </thead>
                <tbody>
                  {job.plans.map((p) => (
                    <tr key={p.id}>
                      <td className="mono">{p.drawingNo ?? '—'}</td>
                      <td>{p.title}</td>
                      <td className="mono">{p.revision}</td>
                      <td>{p.discipline ?? '—'}</td>
                      <td>
                        <span
                          className={`badge ${
                            p.status === 'APPROVED' ? 'ok' : p.status === 'REJECTED' ? 'danger' : 'warn'
                          }`}
                        >
                          {p.status.toLowerCase().replace(/_/g, ' ')}
                        </span>
                      </td>
                      <td className="muted">
                        {p.approvedAt ? `${formatDate(p.approvedAt)}${p.approvedBy ? ` · ${p.approvedBy}` : ''}` : '—'}
                      </td>
                      {can('gops.plans.edit_all') && (
                        <td>
                          {p.status === 'FOR_APPROVAL' && (
                            <button
                              className="btn btn-sm btn-ok"
                              onClick={async () => {
                                await api.patch(`/jobs/${job.id}/plans/${p.id}`, { status: 'APPROVED' });
                                toast('ok', 'Plan approved');
                                await load();
                              }}
                            >
                              Approve
                            </button>
                          )}
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {tab === 'tasks' && <TasksTab job={job} onChanged={load} />}

      {tab === 'activity' && (
        <div className="card">
          <h3 className="card-title">Activity</h3>
          {activity.length === 0 ? (
            <Empty title="No recorded activity" />
          ) : (
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    <th style={{ width: 190 }}>When</th>
                    <th style={{ width: 110 }}>Action</th>
                    <th>Who</th>
                    <th>Detail</th>
                  </tr>
                </thead>
                <tbody>
                  {activity.map((a) => (
                    <tr key={a.id}>
                      <td className="muted">{formatDateTime(a.at)}</td>
                      <td>
                        <span className="badge">{a.action}</span>
                      </td>
                      <td>{a.actorName ?? '—'}</td>
                      <td>{a.summary ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {editing && (
        <EditJobModal
          job={job}
          onClose={() => setEditing(false)}
          onSaved={() => {
            setEditing(false);
            void load();
          }}
        />
      )}

      {budgetRequest && (
        <BudgetRequestModal
          job={job}
          onClose={() => setBudgetRequest(false)}
          onSaved={() => {
            setBudgetRequest(false);
            void load();
          }}
        />
      )}

      {newReport && (
        <NewReportModal
          job={job}
          onClose={() => setNewReport(false)}
          onCreated={(reportId) => navigate(`/g-ops/progress/${reportId}`)}
        />
      )}

      {newPlan && (
        <NewPlanModal
          job={job}
          onClose={() => setNewPlan(false)}
          onSaved={() => {
            setNewPlan(false);
            void load();
          }}
        />
      )}
    </div>
  );
}

function Stat({
  label,
  value,
  sub,
  accent,
  tone,
}: {
  label: string;
  value: React.ReactNode;
  sub?: string;
  accent?: boolean;
  tone?: string;
}) {
  const color = tone === 'danger' ? 'var(--danger)' : tone === 'warn' ? 'var(--warn)' : accent ? 'var(--neon)' : 'var(--text)';
  return (
    <div className="card">
      <div className="faint" style={{ fontSize: 11, letterSpacing: 1 }}>
        {label.toUpperCase()}
      </div>
      <div style={{ fontSize: 18, marginTop: 6, fontWeight: 600, color }}>{value}</div>
      {sub && (
        <div className="faint" style={{ fontSize: 11, marginTop: 3 }}>
          {sub}
        </div>
      )}
    </div>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', gap: 12, padding: '6px 0', borderBottom: '1px solid var(--line-soft)' }}>
      <span className="faint" style={{ width: 140, flexShrink: 0, fontSize: 12 }}>
        {label}
      </span>
      <span>{value || <span className="faint">—</span>}</span>
    </div>
  );
}

// ── Tasks ────────────────────────────────────────────────────────────────────

function TasksTab({ job, onChanged }: { job: Job; onChanged: () => Promise<void> }) {
  const { can } = useAuth();
  const [name, setName] = useState('');
  const [error, setError] = useState<unknown>(null);

  async function add() {
    if (!name) return;
    try {
      await api.post(`/jobs/${job.id}/tasks`, { name });
      setName('');
      await onChanged();
    } catch (err) {
      setError(err);
    }
  }

  async function setStatus(taskId: string, status: string) {
    try {
      await api.patch(`/jobs/${job.id}/tasks/${taskId}`, { status });
      await onChanged();
    } catch (err) {
      setError(err);
    }
  }

  return (
    <div className="card">
      <h3 className="card-title">Tasks</h3>
      <ErrorBox error={error} />
      {job.tasks.length === 0 ? (
        <Empty title="No tasks yet" />
      ) : (
        <div className="table-wrap" style={{ marginBottom: 14 }}>
          <table className="data">
            <thead>
              <tr>
                <th>Task</th>
                <th>Assigned</th>
                <th>Due</th>
                <th>Status</th>
                {can('gops.projects.edit_all') && <th style={{ width: 180 }} />}
              </tr>
            </thead>
            <tbody>
              {job.tasks.map((t) => (
                <tr key={t.id}>
                  <td>{t.name}</td>
                  <td>{t.assignedTo?.name ?? <span className="faint">—</span>}</td>
                  <td>{formatDate(t.dueDate)}</td>
                  <td>
                    <span
                      className={`badge ${
                        t.status === 'DONE' ? 'ok' : t.status === 'BLOCKED' ? 'danger' : t.status === 'IN_PROGRESS' ? 'info' : ''
                      }`}
                    >
                      {t.status.toLowerCase().replace(/_/g, ' ')}
                    </span>
                  </td>
                  {can('gops.projects.edit_all') && (
                    <td>
                      <div className="row" style={{ gap: 5 }}>
                        {t.status !== 'IN_PROGRESS' && t.status !== 'DONE' && (
                          <button className="btn btn-sm" onClick={() => setStatus(t.id, 'IN_PROGRESS')}>
                            Start
                          </button>
                        )}
                        {t.status !== 'DONE' && (
                          <button className="btn btn-sm btn-ok" onClick={() => setStatus(t.id, 'DONE')}>
                            Done
                          </button>
                        )}
                      </div>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {can('gops.projects.edit_all') && (
        <div className="row">
          <input
            value={name}
            placeholder="Add a task…"
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && add()}
            style={{ maxWidth: 400 }}
          />
          <button className="btn btn-sm" onClick={add} disabled={!name}>
            Add
          </button>
        </div>
      )}
    </div>
  );
}

// ── Modals ───────────────────────────────────────────────────────────────────

function EditJobModal({ job, onClose, onSaved }: { job: Job; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [people, setPeople] = useState<{ id: string; name: string }[]>([]);
  const [form, setForm] = useState({
    name: job.name,
    status: job.status,
    projectManagerId: job.projectManager?.id ?? '',
    customerPoNumber: job.customerPoNumber ?? '',
    customerPoDate: job.customerPoDate?.slice(0, 10) ?? '',
    startDate: job.startDate?.slice(0, 10) ?? '',
    targetEndDate: job.targetEndDate?.slice(0, 10) ?? '',
    actualEndDate: job.actualEndDate?.slice(0, 10) ?? '',
    notes: job.notes ?? '',
  });

  useEffect(() => {
    api
      .get<{ rows: { id: string; name: string }[] }>('/users?pageSize=200')
      .then((r) => setPeople(r.rows))
      .catch(() => {});
  }, []);

  async function save() {
    setBusy(true);
    setError(null);
    try {
      await api.patch(`/jobs/${job.id}`, {
        name: form.name,
        status: form.status,
        projectManagerId: form.projectManagerId || null,
        customerPoNumber: form.customerPoNumber || null,
        customerPoDate: form.customerPoDate || null,
        startDate: form.startDate || null,
        targetEndDate: form.targetEndDate || null,
        actualEndDate: form.actualEndDate || null,
        notes: form.notes || null,
      });
      toast('ok', 'Project updated');
      onSaved();
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  }

  return (
    <Modal
      wide
      title={`Edit ${job.number}`}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button className="btn btn-primary" onClick={save} disabled={busy}>
            {busy ? 'Saving…' : 'Save'}
          </button>
        </>
      }
    >
      <ErrorBox error={error} />
      <div className="grid grid-2">
        <Field label="Project name">
          <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        </Field>
        <Field label="Status">
          <select value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value })}>
            {JOB_STATUSES.map((s) => (
              <option key={s.value} value={s.value}>
                {s.label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Project manager">
          <select
            value={form.projectManagerId}
            onChange={(e) => setForm({ ...form, projectManagerId: e.target.value })}
          >
            <option value="">— unassigned —</option>
            {people.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Customer P.O.">
          <input
            value={form.customerPoNumber}
            onChange={(e) => setForm({ ...form, customerPoNumber: e.target.value })}
          />
        </Field>
        <Field label="Start">
          <input
            type="date"
            value={form.startDate}
            onChange={(e) => setForm({ ...form, startDate: e.target.value })}
          />
        </Field>
        <Field label="Target end">
          <input
            type="date"
            value={form.targetEndDate}
            onChange={(e) => setForm({ ...form, targetEndDate: e.target.value })}
          />
        </Field>
      </div>
      <Field label="Notes">
        <textarea value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
      </Field>
    </Modal>
  );
}

function BudgetRequestModal({ job, onClose, onSaved }: { job: Job; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [form, setForm] = useState({ costCategoryId: '', amount: '', reason: '' });

  const category = job.position.find((p) => p.costCategoryId === form.costCategoryId);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const created = await api.post<{ id: string }>('/budget-requests', {
        jobId: job.id,
        costCategoryId: form.costCategoryId,
        amount: Number(form.amount),
        reason: form.reason,
      });
      await api.post(`/budget-requests/${created.id}/submit`);
      toast('ok', 'Budget request submitted for approval');
      onSaved();
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  }

  return (
    <Modal
      title="Raise a budget request"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button
            className="btn btn-primary"
            onClick={submit}
            disabled={busy || !form.costCategoryId || !form.amount || form.reason.length < 5}
          >
            {busy ? 'Submitting…' : 'Submit for approval'}
          </button>
        </>
      }
    >
      <ErrorBox error={error} />
      <p className="muted" style={{ marginTop: 0 }}>
        A budget request <strong>changes</strong> the budget. A purchase request{' '}
        <strong>spends</strong> it. Approving this raises the budgeted column — it does not order
        anything.
      </p>

      <Field label="Budget line">
        <select
          value={form.costCategoryId}
          onChange={(e) => setForm({ ...form, costCategoryId: e.target.value })}
        >
          <option value="">— choose —</option>
          {job.position.map((p) => (
            <option key={p.costCategoryId} value={p.costCategoryId}>
              {p.name}
            </option>
          ))}
        </select>
      </Field>

      {category && (
        <div className="alert info">
          {category.name} today: {formatMoney(category.budgeted)} budgeted,{' '}
          {formatMoney(category.available)} available.
          {form.amount && (
            <>
              {' '}
              After approval: <strong>{formatMoney(category.budgeted + Number(form.amount))}</strong>.
            </>
          )}
        </div>
      )}

      <Field label="Additional amount">
        <input
          type="number"
          step="0.01"
          value={form.amount}
          onChange={(e) => setForm({ ...form, amount: e.target.value })}
        />
      </Field>
      <Field label="Reason" hint="What changed? The approver sees this and nothing else.">
        <textarea value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} />
      </Field>
    </Modal>
  );
}

function NewReportModal({
  job,
  onClose,
  onCreated,
}: {
  job: Job;
  onClose: () => void;
  onCreated: (id: string) => void;
}) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const lastReport = job.progressReports[0];
  const defaultFrom = lastReport
    ? new Date(new Date(lastReport.periodTo).getTime() + 86400000).toISOString().slice(0, 10)
    : (job.startDate?.slice(0, 10) ?? new Date().toISOString().slice(0, 10));

  const [form, setForm] = useState({
    periodFrom: defaultFrom,
    periodTo: new Date().toISOString().slice(0, 10),
  });

  async function create() {
    setBusy(true);
    setError(null);
    try {
      const created = await api.post<{ id: string }>('/progress-reports', {
        jobId: job.id,
        periodFrom: form.periodFrom,
        periodTo: form.periodTo,
      });
      toast('ok', 'Report started — previous percentages carried forward');
      onCreated(created.id);
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  }

  return (
    <Modal
      title="New progress report"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button className="btn btn-primary" onClick={create} disabled={busy}>
            {busy ? 'Starting…' : 'Start report'}
          </button>
        </>
      }
    >
      <ErrorBox error={error} />
      <p className="muted" style={{ marginTop: 0 }}>
        {lastReport
          ? `Report #${lastReport.reportNo + 1}. The to-date percentages from ${lastReport.number} carry forward as this report's opening position.`
          : 'The first report for this project. Every scope line starts at 0%.'}
      </p>
      <div className="grid grid-2">
        <Field label="Period from">
          <input
            type="date"
            value={form.periodFrom}
            onChange={(e) => setForm({ ...form, periodFrom: e.target.value })}
          />
        </Field>
        <Field label="Period to">
          <input
            type="date"
            value={form.periodTo}
            onChange={(e) => setForm({ ...form, periodTo: e.target.value })}
          />
        </Field>
      </div>
    </Modal>
  );
}

function NewPlanModal({ job, onClose, onSaved }: { job: Job; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [form, setForm] = useState({ title: '', drawingNo: '', revision: '0', discipline: '' });

  async function save() {
    setBusy(true);
    setError(null);
    try {
      await api.post(`/jobs/${job.id}/plans`, {
        title: form.title,
        drawingNo: form.drawingNo || null,
        revision: form.revision,
        discipline: form.discipline || null,
      });
      toast('ok', 'Plan registered');
      onSaved();
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  }

  return (
    <Modal
      title="Register a plan"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button className="btn btn-primary" onClick={save} disabled={busy || form.title.length < 2}>
            {busy ? 'Saving…' : 'Save'}
          </button>
        </>
      }
    >
      <ErrorBox error={error} />
      <Field label="Title">
        <input value={form.title} autoFocus onChange={(e) => setForm({ ...form, title: e.target.value })} />
      </Field>
      <div className="grid grid-3">
        <Field label="Drawing no.">
          <input
            className="mono"
            value={form.drawingNo}
            onChange={(e) => setForm({ ...form, drawingNo: e.target.value })}
          />
        </Field>
        <Field label="Revision">
          <input
            className="mono"
            value={form.revision}
            onChange={(e) => setForm({ ...form, revision: e.target.value })}
          />
        </Field>
        <Field label="Discipline">
          <input
            value={form.discipline}
            placeholder="Mechanical, electrical…"
            onChange={(e) => setForm({ ...form, discipline: e.target.value })}
          />
        </Field>
      </div>
      <p className="faint" style={{ fontSize: 12 }}>
        Attach the drawing file from the project's documents once uploaded. A plan starts as{' '}
        <em>for approval</em> — work should not begin until it is approved.
      </p>
    </Modal>
  );
}

/** Opens a PDF that needs the bearer token. */
export function openPdf(path: string, onError: () => void) {
  fetch(path, { headers: { Authorization: `Bearer ${getToken()}` } })
    .then((r) => r.blob())
    .then((b) => window.open(URL.createObjectURL(b), '_blank'))
    .catch(onError);
}
