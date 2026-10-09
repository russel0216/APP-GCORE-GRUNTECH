import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api, type ListResult } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import {
  Empty,
  ErrorBox,
  Field,
  Loading,
  Modal,
  ModalFoot,
  StatusBadge,
  formatDate,
  formatDateTime,
  formatMoney,
  useToast,
} from '../../components/ui';
import { Stat } from '../../components/charts';
import { Attachments } from '../../components/Attachments';
import { RecordHeader } from '../../components/RecordHeader';
import { useConfirm, type ConfirmApi } from '../../components/Confirm';
import { recordLink } from '../../lib/links';
import { SCurve, type CurvePoint } from './SCurve';
import { ProjectGantt } from './ProjectGantt';
import { JOB_STATUSES, JOB_TONES, ProgressBar } from './Projects';
import { todayLocal } from '../../lib/day';
import { NumberInput } from '../../components/NumberInput';
import { ProjectBudgetRequestsCard, BudgetRequestModal } from './BudgetRequests';

/**
 * The project workspace (model §8.1).
 *
 * One record, one page, tabs across it — rather than sending someone back to a
 * menu to find this project's purchase requests. Every child document already
 * links UP to the job; these tabs are the links DOWN.
 *
 * Tabs that read another module's register are shown only to people who hold
 * that register's `view_all`, and each card inside them the same way. A card
 * that would have to say "you may not see this" is hidden rather than empty —
 * an empty card reads as "nothing was bought", which is a different claim.
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
  serviceContract: { id: string; number: string; status: string } | null;
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
    startDate: string | null;
    dueDate: string | null;
    scopeItemId: string | null;
    assignedTo: { id: string; name: string } | null;
  }[];
  budgetRequestCount: number;
  installedAssetCount: number;
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

type Tab =
  | 'overview'
  | 'meetings'
  | 'plans'
  | 'budget'
  | 'procurement'
  | 'requests'
  | 'scope'
  | 'progress'
  | 'finance'
  | 'service';

/**
 * The owner's order (2026-10-06), after the old gasiontech G-CORE's project
 * menu: Overview, Meetings & Records, Approved Plans, Budget Monitoring,
 * Purchase Requisition, Budget Requests, Scope of Work (the Gantt chart),
 * Progress & Billing. Finance and Service stay at the end: the turnover
 * register and the project's invoices live nowhere else.
 */
const TABS: Tab[] = ['overview', 'meetings', 'plans', 'budget', 'procurement', 'requests', 'scope', 'progress', 'finance', 'service'];

/** Where the tabs that used to exist went, so an old link or notification still lands. */
const TAB_ALIASES: Record<string, Tab> = { billing: 'progress', tasks: 'scope', documents: 'meetings', activity: 'meetings' };

/** Plan statuses the shared rules do not already colour. */
const PLAN_TONES = { FOR_APPROVAL: 'warn', SUPERSEDED: '' } as const;

export function ProjectWorkspace() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { can } = useAuth();
  const toast = useToast();
  const confirm = useConfirm();
  const [params, setParams] = useSearchParams();

  const [job, setJob] = useState<Job | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [editing, setEditing] = useState(false);
  const [budgetRequest, setBudgetRequest] = useState(false);
  const [newReport, setNewReport] = useState(false);
  const [newPlan, setNewPlan] = useState(false);
  const [turnover, setTurnover] = useState<'turnover' | 'register' | null>(null);
  const [reloadToken, setReloadToken] = useState(0);
  const [activity, setActivity] = useState<
    { id: string; action: string; summary: string | null; actorName: string | null; at: string }[]
  >([]);

  // Which tab is open lives in the URL, so a notification, the Budget
  // Requests register or the Plans register can open the right one.
  const rawTab = params.get('tab');
  const requested: Tab | null = rawTab ? (TAB_ALIASES[rawTab] ?? (rawTab as Tab)) : null;
  const tab: Tab = requested && TABS.includes(requested) ? requested : 'overview';
  function setTab(next: Tab) {
    const p = new URLSearchParams(params);
    if (next === 'overview') p.delete('tab');
    else p.set('tab', next);
    setParams(p, { replace: true });
  }

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
    if (tab !== 'meetings' || !id) return;
    api.get<typeof activity>(`/audit/job/${id}`).then(setActivity).catch(() => setActivity([]));
  }, [tab, id]);

  if (loading) return <Loading />;
  if (!job) return <ErrorBox error={error ?? new Error('Project not found')} />;

  const s = job.summary;
  const mayEdit = can('gops.projects.edit_all');
  const mayRegister = can('gops.installed_base.create');

  // Which of the cross-module tabs this person can see anything in.
  const procurementKeys = [
    'gchain.purchase_requests.view_all',
    'gchain.purchase_orders.view_all',
    'gchain.receiving.view_all',
    'gchain.stock_issuance.view_all',
    'gchain.borrow_slips.view_all',
  ];
  const financeKeys = [
    'gfin.ar.view_all',
    'gfin.ap.view_all',
    'gfin.expenses.view_all',
    'ghr.overtime.view_all',
    'gops.budget_monitoring.view_all',
  ];
  const serviceKeys = [
    'gops.installed_base.view_all',
    'gops.service_contracts.view_all',
    'gops.commissioning_reports.view_all',
    'gops.pm_reports.view_all',
    'gops.inspection_reports.view_all',
    'gops.job_orders.view_all',
  ];
  const visible: Record<Tab, boolean> = {
    overview: true,
    meetings: true,
    plans: true,
    budget: true,
    procurement: procurementKeys.some(can),
    requests: can('gops.budget_requests.view_all') || can('gops.budget_requests.view_own'),
    scope: true,
    progress: true,
    finance: financeKeys.some(can),
    service: serviceKeys.some(can),
  };
  const current: Tab = visible[tab] ? tab : 'overview';

  /** Asked in the confirm bar first; a refusal is shown there. */
  async function setStatus(status: string) {
    if (!job) return;
    await api.patch(`/jobs/${job.id}`, { status });
    toast('ok', `Moved to ${JOB_STATUSES.find((x) => x.value === status)?.label}`);
    await load();
  }

  const tabLabel: Record<Tab, string> = {
    overview: 'Overview',
    meetings: 'Meetings & Records',
    plans: `Approved Plans (${job.plans.length})`,
    budget: 'Budget Monitoring',
    procurement: 'Purchase Requisition',
    requests: `Budget Requests (${job.budgetRequestCount})`,
    scope: 'Scope of Work (Gantt)',
    progress: `Progress & Billing (${job.progressReports.length})`,
    finance: 'Finance',
    service: job.installedAssetCount ? `Service (${job.installedAssetCount})` : 'Service',
  };

  return (
    <div>
      <RecordHeader
        type={job.type === 'SERVICE_CONTRACT' ? 'Service contract' : 'Project'}
        code={job.number}
        title={job.name}
        status={job.status}
        statusExtra={JOB_TONES}
        statusLabel={JOB_STATUSES.find((x) => x.value === job.status)?.label}
        amount={formatMoney(s.contractValue)}
        amountLabel="Contract value"
        meta={
          <>
            <Link to={`/g-ops/customers/${job.customer.id}`}>{job.customer.name}</Link>
            {job.site ? ` · ${job.site.name}` : ''}
            {job.projectManager ? ` · project manager ${job.projectManager.name}` : ' · no project manager'}
            {job.costing && (
              <>
                {' '}
                · from{' '}
                <Link className="mono" to={`/g-ops/costing/${job.costing.id}`}>
                  {job.costing.number}
                </Link>
              </>
            )}
            {job.quotationRevision && (
              <>
                {' '}
                · delivers{' '}
                <Link className="mono" to={`/g-ops/quotations/${job.quotationRevision.quotation.id}`}>
                  {job.quotationRevision.quotation.number} R{job.quotationRevision.revision}
                </Link>
              </>
            )}
          </>
        }
        actions={
          <>
            {mayEdit && job.status === 'PLANNING' && (
              <button
                className="btn btn-primary"
                onClick={() =>
                  confirm.ask({
                    title: `Start ${job.number}?`,
                    body: 'It moves to In progress.',
                    confirmLabel: 'Start',
                    tone: 'primary',
                    onConfirm: () => setStatus('IN_PROGRESS'),
                  })
                }
              >
                Start
              </button>
            )}
            {mayEdit && job.status === 'IN_PROGRESS' && (
              <button
                className="btn btn-primary"
                onClick={() =>
                  confirm.ask({
                    title: `Mark ${job.number} complete?`,
                    body: mayRegister
                      ? 'It moves to Completed. Turn it over next, registering what it installed.'
                      : 'It moves to Completed.',
                    confirmLabel: 'Mark complete',
                    tone: 'primary',
                    onConfirm: () => setStatus('COMPLETED'),
                  })
                }
              >
                Mark complete
              </button>
            )}
            {/* Turnover is where the installed base begins: the equipment is
                registered in the same act, or it never is. */}
            {mayEdit && mayRegister && job.status === 'COMPLETED' && (
              <button className="btn btn-primary" onClick={() => setTurnover('turnover')}>
                Turn over
              </button>
            )}
          </>
        }
        more={[
          mayEdit &&
            (job.status === 'PLANNING' || job.status === 'IN_PROGRESS') && {
              label: 'Put on hold',
              confirm: {
                title: `Put ${job.number} on hold?`,
                body: 'It moves to On hold until somebody resumes it.',
                confirmLabel: 'Put on hold',
                tone: 'primary',
                onConfirm: () => setStatus('ON_HOLD'),
              },
            },
          mayEdit &&
            job.status === 'ON_HOLD' && {
              label: 'Resume',
              confirm: {
                title: `Resume ${job.number}?`,
                body: 'It moves back to In progress.',
                confirmLabel: 'Resume',
                tone: 'primary',
                onConfirm: () => setStatus('IN_PROGRESS'),
              },
            },
          mayEdit &&
            job.status !== 'CANCELLED' &&
            job.status !== 'TURNED_OVER' && {
              label: job.type === 'SERVICE_CONTRACT' ? 'Cancel service contract' : 'Cancel project',
              danger: true,
              confirm: {
                title: `Cancel ${job.number}?`,
                body: 'It moves to Cancelled. Its documents and ledger stay as they are.',
                confirmLabel: job.type === 'SERVICE_CONTRACT' ? 'Cancel service contract' : 'Cancel project',
                onConfirm: () => setStatus('CANCELLED'),
              },
            },
        ]}
        modify={mayEdit ? () => setEditing(true) : undefined}
        confirm={confirm}
      />

      <ErrorBox error={error} />

      {/* The numbers a project manager actually opens this page for. */}
      <div className="kpi-grid">
        <Stat
          label="Progress"
          value={<ProgressBar pct={s.progressPct} />}
          hint={`${formatMoney(s.earnedValue)} earned`}
        />
        <Stat
          label="Billed"
          value={formatMoney(s.billed)}
          figure
          hint={`${s.billedPct.toFixed(1)}% of contract`}
        />
        <Stat
          label="Unbilled work"
          value={formatMoney(s.unbilled)}
          figure
          hint="done but not invoiced"
          accent={s.unbilled > 0 ? 'warn' : undefined}
        />
      </div>

      <div className="kpi-grid">
        <Stat label="Budget" value={formatMoney(s.budgeted)} figure />
        <Stat
          label="Committed + incurred"
          value={formatMoney(s.actualCost)}
          figure
          hint={s.budgeted > 0 ? `${s.costUsedPct.toFixed(1)}% of budget` : undefined}
        />
        <Stat
          label="Available"
          value={formatMoney(s.available)}
          figure
          hint={s.available < 0 ? 'over budget' : 'budget not yet spent or promised'}
          accent={s.available < 0 ? 'danger' : undefined}
        />
        {/* Expected margin, not margin-so-far. A job that has spent nothing
            would otherwise read 100%, which is true and useless. */}
        <Stat
          label="Expected margin"
          value={`${s.expectedMarginPct.toFixed(1)}%`}
          hint={`${formatMoney(s.expectedProfit)} if delivered to budget`}
          accent={s.expectedMarginPct < 0 ? 'danger' : s.expectedMarginPct < 10 ? 'warn' : 'ok'}
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

      <div className="scope-switch del-tabs" role="tablist" aria-label="Project sections">
        {TABS.filter((t) => visible[t]).map((key) => (
          <button
            key={key}
            role="tab"
            aria-selected={current === key}
            className={current === key ? 'active' : ''}
            onClick={() => setTab(key)}
          >
            {tabLabel[key]}
          </button>
        ))}
      </div>

      {current === 'overview' && (
        <div className="grid grid-2">
          <div className="card del-span-all">
            <h3 className="card-title">S-curve — planned vs actual vs billed</h3>
            <SCurve points={job.curve} />
            <p className="faint del-note">
              The gap between planned and actual is schedule slip. The gap between actual and
              billed is work you have done but not yet invoiced.
            </p>
          </div>

          <div className="card">
            <h3 className="card-title">Contract</h3>
            <dl className="kv">
              <Row label="Number" value={<span className="mono">{job.number}</span>} />
              <Row label="Type" value={job.type === 'PROJECT' ? 'Project' : 'Service contract'} />
              <Row label="Customer P.O." value={job.customerPoNumber} />
              <Row label="P.O. date" value={job.customerPoDate ? formatDate(job.customerPoDate) : null} />
              <Row label="Contract value" value={formatMoney(job.contractValue)} />
              <Row
                label="From costing"
                value={job.costing ? <Link to={`/g-ops/costing/${job.costing.id}`}>{job.costing.number}</Link> : null}
              />
              <Row
                label="Quotation"
                value={
                  job.quotationRevision ? (
                    <Link to={`/g-ops/quotations/${job.quotationRevision.quotation.id}`}>
                      {job.quotationRevision.quotation.number} R{job.quotationRevision.revision}
                    </Link>
                  ) : null
                }
              />
              <Row label="Estimated cost" value={job.costing ? formatMoney(job.costing.totalCost) : null} />
              {job.serviceContract && (
                <Row
                  label="Coverage terms"
                  value={
                    <>
                      <Link className="mono" to={`/g-ops/service-contracts/${job.serviceContract.id}`}>
                        {job.serviceContract.number}
                      </Link>{' '}
                      <StatusBadge status={job.serviceContract.status} />
                    </>
                  }
                />
              )}
            </dl>
          </div>

          <div className="card">
            <h3 className="card-title">Schedule</h3>
            <dl className="kv">
              <Row label="Start" value={job.startDate ? formatDate(job.startDate) : null} />
              <Row label="Target end" value={job.targetEndDate ? formatDate(job.targetEndDate) : null} />
              <Row label="Actual end" value={job.actualEndDate ? formatDate(job.actualEndDate) : null} />
              <Row label="Project manager" value={job.projectManager?.name} />
              <Row label="Site" value={job.site ? [job.site.name, job.site.city].filter(Boolean).join(' — ') : null} />
              <Row label="Created by" value={job.createdBy.name} />
            </dl>
          </div>

          {job.notes && (
            <div className="card del-span-all">
              <h3 className="card-title">Notes</h3>
              <div className="del-prose">{job.notes}</div>
            </div>
          )}
        </div>
      )}

      {current === 'budget' && <BudgetTab job={job} reloadToken={reloadToken} />}

      {current === 'requests' && (
        <ProjectBudgetRequestsCard
          job={job}
          reloadToken={reloadToken}
          onRaise={can('gops.budget_requests.create') ? () => setBudgetRequest(true) : undefined}
        />
      )}

      {current === 'scope' && (
        <div className="stack">
        <ProjectGantt
          jobId={job.id}
          jobStart={job.startDate}
          jobEnd={job.targetEndDate}
          scopeItems={job.scopeItems}
          tasks={job.tasks}
          hasCosting={!!job.costing}
          canEdit={mayEdit}
          onChanged={load}
        />
        <div className="card">
          <h3 className="card-title">Schedule of values</h3>
          <p className="muted del-lede">
            Snapshotted from the costing when the project was created. Values are fixed — progress
            and billing are measured against them, so changing one after billing has started would
            rewrite history.
          </p>
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>#</th>
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
                      {job.contractValue > 0 ? ((item.value / job.contractValue) * 100).toFixed(1) : '0.0'}%
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
                    <strong>{formatMoney(job.scopeItems.reduce((sum, i) => sum + i.value, 0))}</strong>
                  </td>
                  <td colSpan={3} />
                </tr>
              </tbody>
            </table>
          </div>
        </div>
        </div>
      )}

      {current === 'plans' && (
        <PlansTab
          job={job}
          onAdd={can('gops.plans.create') ? () => setNewPlan(true) : undefined}
          onChanged={load}
          confirm={confirm}
        />
      )}

      {current === 'procurement' && <ProcurementTab job={job} />}

      {current === 'progress' && (
        <div className="stack">
        <div className="card">
          <div className="del-card-head">
            <h3 className="card-title">Progress reports</h3>
            {can('gops.progress_billing.create') && (
              <button className="btn btn-primary btn-sm" onClick={() => setNewReport(true)}>
                + New progress report
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
                    <th>#</th>
                    <th>Number</th>
                    <th>Period</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {job.progressReports.map((r) => (
                    <tr key={r.id}>
                      <td className="mono">{r.reportNo}</td>
                      <td>
                        <Link className="mono" to={`/g-ops/progress/${r.id}`}>
                          {r.number}
                        </Link>
                      </td>
                      <td>
                        {formatDate(r.periodFrom)} — {formatDate(r.periodTo)}
                      </td>
                      <td>
                        <StatusBadge status={r.status} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
        <div className="card">
          <h3 className="card-title">Progress billings</h3>
          <p className="muted del-lede">
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
                    <th>#</th>
                    <th>Number</th>
                    <th>Date</th>
                    <th className="right">Gross</th>
                    <th className="right">Net collectible</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {job.billings.map((b) => (
                    <tr key={b.id}>
                      <td className="mono">{b.billingNo}</td>
                      <td>
                        <Link className="mono" to={`/g-ops/billings/${b.id}`}>
                          {b.number}
                        </Link>
                      </td>
                      <td>{formatDate(b.billingDate)}</td>
                      <td className="right mono">{formatMoney(b.grossAmount)}</td>
                      <td className="right mono">{formatMoney(b.netCollectible)}</td>
                      <td>
                        <StatusBadge status={b.status} />
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
        </div>
      )}

      {current === 'finance' && <FinanceTab job={job} />}

      {current === 'service' && (
        <ServiceTab
          job={job}
          reloadToken={reloadToken}
          onRegister={mayRegister && job.status === 'TURNED_OVER' ? () => setTurnover('register') : undefined}
        />
      )}

      {current === 'meetings' && (
        <div className="stack">
        <ProjectMeetingsCard job={job} />
        <Attachments
          entityType="job"
          entityId={job.id}
          title="Project documents"
          hint="Contracts, permits, minutes, as-builts, turnover papers — anything this project is answerable for."
          canEdit={mayEdit || can('gops.projects.create')}
        />
        <div className="card">
          <h3 className="card-title">Activity</h3>
          {activity.length === 0 ? (
            <Empty title="No recorded activity" />
          ) : (
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    <th>When</th>
                    <th>Action</th>
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
            setReloadToken((t) => t + 1);
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

      {turnover && (
        <TurnoverModal
          job={job}
          mode={turnover}
          onClose={() => setTurnover(null)}
          onDone={() => {
            setTurnover(null);
            setReloadToken((t) => t + 1);
            void load();
          }}
        />
      )}
    </div>
  );
}

/** One label / value pair inside a `.kv` list. */
function Row({ label, value }: { label: string; value: ReactNode }) {
  return (
    <>
      <dt>{label}</dt>
      <dd>{value || <span className="faint">—</span>}</dd>
    </>
  );
}

// ── Related registers ────────────────────────────────────────────────────────

interface RelCol<T> {
  label: string;
  render: (row: T) => ReactNode;
  align?: 'right';
}

/**
 * A compact read of another module's register, narrowed to this job.
 *
 * The list endpoint does the filtering (`?jobId=`); `belongs` checks it again
 * on the rows that come back, so a register that has not learned the filter yet
 * shows nothing rather than every other project's documents under this one.
 */
function RelatedCard<T extends { id: string }>({
  title,
  endpoint,
  jobId,
  columns,
  belongs,
  empty,
  action,
  blurb,
}: {
  title: string;
  endpoint: string;
  jobId: string;
  columns: RelCol<T>[];
  belongs: (row: T) => boolean;
  empty: string;
  action?: ReactNode;
  blurb?: string;
}) {
  const [rows, setRows] = useState<T[] | null>(null);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    let live = true;
    api
      .get<ListResult<T>>(`${endpoint}?jobId=${encodeURIComponent(jobId)}&pageSize=50`)
      .then((r) => {
        if (!live) return;
        const mine = r.rows.filter(belongs);
        setRows(mine);
        setTotal(mine.length === r.rows.length ? r.total : mine.length);
      })
      .catch((err) => live && setError(err));
    return () => {
      live = false;
    };
    // `belongs` is a fresh closure every render; the endpoint and job decide.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [endpoint, jobId]);

  return (
    <section className="card">
      <div className="del-card-head">
        <h3 className="card-title">
          {title}
          {rows && rows.length > 0 ? ` (${total})` : ''}
        </h3>
        {action}
      </div>
      {blurb && <p className="muted del-lede">{blurb}</p>}
      <ErrorBox error={error} />
      {!rows && !error ? (
        <Loading />
      ) : rows && rows.length === 0 ? (
        <p className="faint del-note">{empty}</p>
      ) : rows ? (
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                {columns.map((c) => (
                  <th key={c.label} className={c.align === 'right' ? 'right' : undefined}>
                    {c.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  {columns.map((c) => (
                    <td key={c.label} className={c.align === 'right' ? 'right mono' : undefined}>
                      {c.render(r)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
          {total > rows.length && (
            <p className="faint del-note">
              Showing the latest {rows.length} of {total}.
            </p>
          )}
        </div>
      ) : null}
    </section>
  );
}

/** A document number that opens the document. */
function DocLink({ to, children }: { to: string; children: ReactNode }) {
  return (
    <Link className="mono" to={to}>
      {children}
    </Link>
  );
}

interface Named {
  id: string;
  name: string;
}
interface JobRef {
  id: string;
  number: string;
  name: string;
}

function ProcurementTab({ job }: { job: Job }) {
  const { can } = useAuth();
  const onJob = (j: { id: string } | null | undefined) => j?.id === job.id;

  return (
    <div className="stack">
      {can('gchain.purchase_requests.view_all') && (
        <RelatedCard<{
          id: string;
          number: string;
          kind: string;
          status: string;
          purpose: string;
          neededBy: string | null;
          estimatedTotal: number;
          requestedBy: Named;
          job: JobRef | null;
        }>
          title="Purchase requests"
          endpoint="/purchase-requests"
          jobId={job.id}
          belongs={(r) => onJob(r.job)}
          empty="Nothing requested for this project yet."
          action={
            can('gchain.purchase_requests.create') ? (
              <Link className="btn btn-primary btn-sm" to={`/g-chain/purchase-requests?new=1&jobId=${job.id}`}>
                + New purchase request
              </Link>
            ) : undefined
          }
          columns={[
            { label: 'Number', render: (r) => <DocLink to={`/g-chain/purchase-requests/${r.id}`}>{r.number}</DocLink> },
            { label: 'Purpose', render: (r) => r.purpose },
            { label: 'Needed by', render: (r) => formatDate(r.neededBy) },
            { label: 'Raised by', render: (r) => r.requestedBy.name },
            { label: 'Estimate', align: 'right', render: (r) => formatMoney(r.estimatedTotal) },
            { label: 'Status', render: (r) => <StatusBadge status={r.status} /> },
          ]}
        />
      )}

      {can('gchain.purchase_orders.view_all') && (
        <RelatedCard<{
          id: string;
          number: string;
          status: string;
          orderDate: string | null;
          total: number;
          receivedPct: number;
          supplier: Named;
          job: JobRef | null;
        }>
          title="Purchase orders"
          endpoint="/purchase-orders"
          jobId={job.id}
          belongs={(r) => onJob(r.job)}
          empty="No orders placed for this project."
          columns={[
            { label: 'Number', render: (r) => <DocLink to={`/g-chain/purchase-orders/${r.id}`}>{r.number}</DocLink> },
            { label: 'Supplier', render: (r) => <Link to={`/g-chain/suppliers/${r.supplier.id}`}>{r.supplier.name}</Link> },
            { label: 'Ordered', render: (r) => formatDate(r.orderDate) },
            { label: 'Received', align: 'right', render: (r) => `${r.receivedPct.toFixed(0)}%` },
            { label: 'Total', align: 'right', render: (r) => formatMoney(r.total) },
            { label: 'Status', render: (r) => <StatusBadge status={r.status} /> },
          ]}
        />
      )}

      {can('gchain.receiving.view_all') && (
        <RelatedCard<{
          id: string;
          number: string;
          receivedDate: string;
          deliveryRefNo: string | null;
          value: number;
          order: { id: string; number: string; supplier: Named; job: JobRef | null };
        }>
          title="Receiving"
          endpoint="/receivings"
          jobId={job.id}
          belongs={(r) => onJob(r.order?.job)}
          empty="Nothing received against this project's orders."
          columns={[
            { label: 'Number', render: (r) => <DocLink to={`/g-chain/receiving/${r.id}`}>{r.number}</DocLink> },
            { label: 'Order', render: (r) => <DocLink to={`/g-chain/purchase-orders/${r.order.id}`}>{r.order.number}</DocLink> },
            { label: 'Supplier', render: (r) => r.order.supplier.name },
            { label: 'Received', render: (r) => formatDate(r.receivedDate) },
            { label: 'Value', align: 'right', render: (r) => formatMoney(r.value) },
          ]}
        />
      )}

      {can('gchain.stock_issuance.view_all') && (
        <RelatedCard<{
          id: string;
          number: string;
          status: string;
          issueDate: string;
          issuedToName: string | null;
          value: number;
          job: JobRef | null;
        }>
          title="Stock issued"
          endpoint="/stock-issues"
          jobId={job.id}
          belongs={(r) => onJob(r.job)}
          empty="No stock issued to this project."
          columns={[
            { label: 'Number', render: (r) => <DocLink to={`/g-chain/stock-issuance/${r.id}`}>{r.number}</DocLink> },
            { label: 'Date', render: (r) => formatDate(r.issueDate) },
            { label: 'Issued to', render: (r) => r.issuedToName ?? '—' },
            { label: 'Value', align: 'right', render: (r) => formatMoney(r.value) },
            { label: 'Status', render: (r) => <StatusBadge status={r.status} /> },
          ]}
        />
      )}

      {can('gchain.borrow_slips.view_all') && (
        <RelatedCard<{
          id: string;
          number: string;
          status: string;
          borrowerName: string;
          borrowedAt: string;
          dueAt: string;
          job: JobRef | null;
        }>
          title="Tools borrowed"
          endpoint="/borrow-slips"
          jobId={job.id}
          belongs={(r) => onJob(r.job)}
          blurb="Borrowing charges nothing to the project — the tools stay company stock."
          empty="No tools out against this project."
          columns={[
            { label: 'Number', render: (r) => <DocLink to={`/g-chain/borrow-slips/${r.id}`}>{r.number}</DocLink> },
            { label: 'Borrower', render: (r) => r.borrowerName },
            { label: 'Out', render: (r) => formatDate(r.borrowedAt) },
            { label: 'Due back', render: (r) => formatDate(r.dueAt) },
            { label: 'Status', render: (r) => <StatusBadge status={r.status} /> },
          ]}
        />
      )}
    </div>
  );
}

// ── Finance ──────────────────────────────────────────────────────────────────

interface AdvanceRow {
  id: string;
  number: string;
  status: string;
  purpose: string;
  requestDate: string;
  amount: number;
  amountReleased: number;
  spent: number;
  refundDue: number;
  liquidationDueDate: string | null;
  liquidationOverdue: boolean;
  requestedBy: Named;
  liquidation: { id: string; number: string; status: string; total: number } | null;
}

interface ClaimRow {
  id: string;
  number: string;
  status: string;
  purpose: string;
  claimDate: string;
  total: number;
  kind: 'liquidation' | 'reimbursement';
  claimedBy: Named;
  job: JobRef | null;
}

const claimColumns: RelCol<ClaimRow>[] = [
  { label: 'Number', render: (r) => <DocLink to={`/g-fin/expenses/${r.id}`}>{r.number}</DocLink> },
  { label: 'Kind', render: (r) => (r.kind === 'liquidation' ? 'Liquidation' : 'Reimbursement') },
  { label: 'Claimed by', render: (r) => r.claimedBy.name },
  { label: 'Date', render: (r) => formatDate(r.claimDate) },
  { label: 'Total', align: 'right', render: (r) => formatMoney(r.total) },
  { label: 'Status', render: (r) => <StatusBadge status={r.status} /> },
];

function FinanceTab({ job }: { job: Job }) {
  const { can } = useAuth();
  const onJob = (j: { id: string } | null | undefined) => j?.id === job.id;
  const seesBudget = can('gops.budget_monitoring.view_all');

  // Advances and liquidations charged to this job — Finance's route, gated on
  // the budget right, because this is the project's cost seen from the job.
  const [forJob, setForJob] = useState<{ advances: AdvanceRow[]; claims: ClaimRow[] } | null>(null);
  const [forJobError, setForJobError] = useState<unknown>(null);
  useEffect(() => {
    if (!seesBudget) return;
    api
      .get<{ advances: AdvanceRow[]; claims: ClaimRow[] }>(`/cash-advances/for-job/${job.id}`)
      .then(setForJob)
      .catch(setForJobError);
  }, [job.id, seesBudget]);

  return (
    <div className="stack">
      {can('gfin.ar.view_all') && (
        <RelatedCard<{
          id: string;
          number: string;
          status: string;
          invoiceDate: string;
          invoiceTotal: number;
          netCollectible: number;
          outstanding: number;
          progressBilling: { id: string; number: string } | null;
          job: JobRef | null;
        }>
          title="Invoices"
          endpoint="/invoices"
          jobId={job.id}
          belongs={(r) => onJob(r.job)}
          blurb="Net collectible is what arrives as cash — the customer withholds EWT at source, so it is never overdue."
          empty="Nothing invoiced on this project yet."
          columns={[
            { label: 'Number', render: (r) => <DocLink to={`/g-fin/ar/${r.id}`}>{r.number}</DocLink> },
            {
              label: 'Billing',
              render: (r) =>
                r.progressBilling ? (
                  <DocLink to={`/g-ops/billings/${r.progressBilling.id}`}>{r.progressBilling.number}</DocLink>
                ) : (
                  '—'
                ),
            },
            { label: 'Date', render: (r) => formatDate(r.invoiceDate) },
            { label: 'Invoice total', align: 'right', render: (r) => formatMoney(r.invoiceTotal) },
            { label: 'Net collectible', align: 'right', render: (r) => formatMoney(r.netCollectible) },
            { label: 'Outstanding', align: 'right', render: (r) => formatMoney(r.outstanding) },
            { label: 'Status', render: (r) => <StatusBadge status={r.status} /> },
          ]}
        />
      )}

      {can('gfin.ap.view_all') && (
        <RelatedCard<{
          id: string;
          number: string;
          status: string;
          billDate: string;
          dueDate: string;
          total: number;
          supplier: Named;
          job: JobRef | null;
        }>
          title="Supplier bills"
          endpoint="/supplier-bills"
          jobId={job.id}
          belongs={(r) => onJob(r.job)}
          blurb="A bill matched to a receiving adds no cost here — the receiving already charged it."
          empty="No supplier bills against this project."
          columns={[
            { label: 'Number', render: (r) => <DocLink to={`/g-fin/ap/${r.id}`}>{r.number}</DocLink> },
            { label: 'Supplier', render: (r) => r.supplier.name },
            { label: 'Bill date', render: (r) => formatDate(r.billDate) },
            { label: 'Due', render: (r) => formatDate(r.dueDate) },
            { label: 'Total', align: 'right', render: (r) => formatMoney(r.total) },
            { label: 'Status', render: (r) => <StatusBadge status={r.status} /> },
          ]}
        />
      )}

      {seesBudget && (
        <section className="card">
          <h3 className="card-title">Cash advances &amp; liquidations</h3>
          <p className="muted del-lede">
            An advance charges nothing when it is approved or released. The project is charged once,
            at what was actually spent, when the liquidation is approved.
          </p>
          <ErrorBox error={forJobError} />
          {!forJob && !forJobError ? (
            <Loading />
          ) : forJob && forJob.advances.length === 0 ? (
            <p className="faint del-note">No cash advanced against this project.</p>
          ) : forJob ? (
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    <th>Advance</th>
                    <th>Requested by</th>
                    <th>Purpose</th>
                    <th className="right">Released</th>
                    <th className="right">Spent</th>
                    <th>Liquidation</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {forJob.advances.map((a) => (
                    <tr key={a.id}>
                      <td>
                        <DocLink to={`/g-fin/cash-advances/${a.id}`}>{a.number}</DocLink>
                      </td>
                      <td>{a.requestedBy.name}</td>
                      <td>{a.purpose}</td>
                      <td className="right mono">{formatMoney(a.amountReleased)}</td>
                      <td className="right mono">{a.liquidation ? formatMoney(a.spent) : '—'}</td>
                      <td>
                        {a.liquidation ? (
                          <>
                            <DocLink to={`/g-fin/expenses/${a.liquidation.id}`}>{a.liquidation.number}</DocLink>{' '}
                            <StatusBadge status={a.liquidation.status} />
                          </>
                        ) : a.liquidationDueDate ? (
                          <span className={a.liquidationOverdue ? 'del-danger' : 'faint'}>
                            due {formatDate(a.liquidationDueDate)}
                            {a.liquidationOverdue ? ' — overdue' : ''}
                          </span>
                        ) : (
                          <span className="faint">—</span>
                        )}
                      </td>
                      <td>
                        <StatusBadge status={a.status} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
        </section>
      )}

      {can('gfin.expenses.view_all') ? (
        <RelatedCard<ClaimRow>
          title="Expense claims"
          endpoint="/expense-claims"
          jobId={job.id}
          belongs={(r) => onJob(r.job)}
          empty="No expense claims charged to this project."
          columns={claimColumns}
        />
      ) : (
        seesBudget &&
        forJob &&
        forJob.claims.length > 0 && (
          <section className="card">
            <h3 className="card-title">Expense claims ({forJob.claims.length})</h3>
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    {claimColumns.map((c) => (
                      <th key={c.label} className={c.align === 'right' ? 'right' : undefined}>
                        {c.label}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {forJob.claims.map((r) => (
                    <tr key={r.id}>
                      {claimColumns.map((c) => (
                        <td key={c.label} className={c.align === 'right' ? 'right mono' : undefined}>
                          {c.render(r)}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        )
      )}

      {can('ghr.overtime.view_all') && (
        <RelatedCard<{
          id: string;
          number: string;
          stage: string;
          date: string;
          estimatedHours: number;
          actualHours: number | null;
          amount: number | null;
          employee: { id: string; firstName: string; lastName: string };
          job: JobRef | null;
        }>
          title="Overtime"
          endpoint="/overtime"
          jobId={job.id}
          belongs={(r) => onJob(r.job)}
          blurb="Posted at the burdened rate once both supervisor and HR approve. The amount charged is shown; the rate never is."
          empty="No overtime charged to this project."
          columns={[
            { label: 'Number', render: (r) => <DocLink to={`/g-hr/overtime/${r.id}`}>{r.number}</DocLink> },
            { label: 'Employee', render: (r) => `${r.employee.firstName} ${r.employee.lastName}` },
            { label: 'Date', render: (r) => formatDate(r.date) },
            {
              label: 'Hours',
              align: 'right',
              render: (r) => (r.actualHours ?? r.estimatedHours).toFixed(2),
            },
            {
              // Only a posted filing has cost the project anything.
              label: 'Posted',
              align: 'right',
              render: (r) => (r.stage === 'APPROVED' && r.amount != null ? formatMoney(r.amount) : '—'),
            },
            { label: 'Stage', render: (r) => <StatusBadge status={r.stage} /> },
          ]}
        />
      )}
    </div>
  );
}

// ── Service ──────────────────────────────────────────────────────────────────

interface ServiceRead {
  assets:
    | {
        id: string;
        code: string;
        name: string;
        manufacturer: string | null;
        model: string | null;
        serialNo: string | null;
        location: string | null;
        status: string;
        installedAt: string | null;
        warrantyEndsAt: string | null;
      }[]
    | null;
  contract: {
    id: string;
    number: string;
    status: string;
    startsAt: string;
    endsAt: string;
    frequencyMonths: number;
    plannedVisits: number;
    assetCount: number;
    renewedFrom: { id: string; number: string } | null;
    renewedTo: { id: string; number: string } | null;
  } | null;
  contractVisible: boolean;
  reports:
    | {
        id: string;
        number: string;
        kind: string;
        status: string;
        performedAt: string;
        billable: boolean;
        asset: { id: string; code: string; name: string } | null;
        performedBy: Named;
      }[]
    | null;
  jobOrders:
    | { id: string; number: string; title: string; projectName: string | null; status: string; kind: string; requestedFor: string; targetFinish: string | null }[]
    | null;
}

const KIND_LABEL: Record<string, string> = {
  COMMISSIONING: 'Commissioning',
  PREVENTIVE_MAINTENANCE: 'Preventive maintenance',
  INSPECTION: 'Inspection',
  CORRECTIVE: 'Corrective',
};

function ServiceTab({
  job,
  reloadToken,
  onRegister,
}: {
  job: Job;
  reloadToken: number;
  onRegister?: () => void;
}) {
  const [data, setData] = useState<ServiceRead | null>(null);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    api.get<ServiceRead>(`/jobs/${job.id}/service`).then(setData).catch(setError);
  }, [job.id, reloadToken]);

  if (error) return <ErrorBox error={error} />;
  if (!data) return <Loading />;
  const today = todayLocal();

  return (
    <div className="stack">
      {data.contractVisible && job.type === 'SERVICE_CONTRACT' && (
        <section className="card">
          <h3 className="card-title">Coverage terms</h3>
          {data.contract ? (
            <dl className="kv">
              <Row
                label="Contract"
                value={
                  <>
                    <DocLink to={`/g-ops/service-contracts/${data.contract.id}`}>{data.contract.number}</DocLink>{' '}
                    <StatusBadge status={data.contract.status} />
                  </>
                }
              />
              <Row
                label="Cover"
                value={`${formatDate(data.contract.startsAt)} — ${formatDate(data.contract.endsAt)}`}
              />
              <Row
                label="Visits"
                value={`${data.contract.plannedVisits} planned, every ${data.contract.frequencyMonths} month(s)`}
              />
              <Row label="Equipment covered" value={String(data.contract.assetCount)} />
              {data.contract.renewedFrom && (
                <Row
                  label="Renewal of"
                  value={
                    <DocLink to={`/g-ops/service-contracts/${data.contract.renewedFrom.id}`}>
                      {data.contract.renewedFrom.number}
                    </DocLink>
                  }
                />
              )}
              {data.contract.renewedTo && (
                <Row
                  label="Renewed as"
                  value={
                    <DocLink to={`/g-ops/service-contracts/${data.contract.renewedTo.id}`}>
                      {data.contract.renewedTo.number}
                    </DocLink>
                  }
                />
              )}
            </dl>
          ) : (
            <p className="faint del-note">
              This service job has no coverage terms yet. Add them from{' '}
              <Link to="/g-ops/service-contracts">Service Contracts</Link> — that is where its PM
              schedule comes from.
            </p>
          )}
        </section>
      )}

      {data.assets && (
        <section className="card">
          <div className="del-card-head">
            <h3 className="card-title">Equipment installed ({data.assets.length})</h3>
            {onRegister && (
              <button className="btn btn-sm" onClick={onRegister}>
                + Add equipment
              </button>
            )}
          </div>
          {data.assets.length === 0 ? (
            <p className="faint del-note">
              {job.type === 'PROJECT'
                ? 'Nothing registered from this project. Equipment is registered when the project is turned over.'
                : 'This job installed nothing — a service contract covers equipment registered by other projects.'}
            </p>
          ) : (
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    <th>Code</th>
                    <th>Equipment</th>
                    <th>Serial no.</th>
                    <th>Location</th>
                    <th>Installed</th>
                    <th>Warranty until</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {data.assets.map((a) => (
                    <tr key={a.id}>
                      <td>
                        <DocLink to={`/g-ops/installed-base/${a.id}`}>{a.code}</DocLink>
                      </td>
                      <td>
                        <div>{a.name}</div>
                        {(a.manufacturer || a.model) && (
                          <div className="faint">{[a.manufacturer, a.model].filter(Boolean).join(' · ')}</div>
                        )}
                      </td>
                      <td className="mono">{a.serialNo ?? '—'}</td>
                      <td>{a.location ?? '—'}</td>
                      <td>{formatDate(a.installedAt)}</td>
                      <td>
                        {a.warrantyEndsAt ? (
                          <span className={a.warrantyEndsAt.slice(0, 10) < today ? 'faint' : undefined}>
                            {formatDate(a.warrantyEndsAt)}
                            {a.warrantyEndsAt.slice(0, 10) < today ? ' — lapsed' : ''}
                          </span>
                        ) : (
                          '—'
                        )}
                      </td>
                      <td>
                        <StatusBadge status={a.status} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}

      {data.reports && (
        <section className="card">
          <h3 className="card-title">Service reports ({data.reports.length})</h3>
          {data.reports.length === 0 ? (
            <p className="faint del-note">No reports written against this job or its equipment.</p>
          ) : (
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    <th>Number</th>
                    <th>Kind</th>
                    <th>Equipment</th>
                    <th>Performed</th>
                    <th>By</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {data.reports.map((r) => (
                    <tr key={r.id}>
                      <td>
                        <DocLink to={`/g-ops/service-reports/${r.id}`}>{r.number}</DocLink>
                      </td>
                      <td>{KIND_LABEL[r.kind] ?? r.kind}</td>
                      <td>{r.asset ? `${r.asset.code} — ${r.asset.name}` : '—'}</td>
                      <td>{formatDate(r.performedAt)}</td>
                      <td>{r.performedBy.name}</td>
                      <td>
                        <StatusBadge status={r.status} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}

      {data.jobOrders && (
        <section className="card">
          <h3 className="card-title">Job orders ({data.jobOrders.length})</h3>
          {data.jobOrders.length === 0 ? (
            <p className="faint del-note">No job orders charged to this job.</p>
          ) : (
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    <th>Number</th>
                    <th>Title</th>
                    <th>Target</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {data.jobOrders.map((o) => (
                    <tr key={o.id}>
                      <td>
                        <DocLink to={`/g-ops/job-orders/${o.id}`}>{o.number}</DocLink>
                      </td>
                      <td>{o.projectName ?? o.title}</td>
                      <td>
                        {formatDate(o.requestedFor)}
                        {o.targetFinish ? ` → ${formatDate(o.targetFinish)}` : ''}
                      </td>
                      <td>
                        <StatusBadge status={o.status} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}
    </div>
  );
}

// ── Budget ───────────────────────────────────────────────────────────────────

interface LedgerRow {
  id: string;
  state: string;
  amount: number;
  sourceType: string;
  sourceId: string | null;
  sourceNumber: string | null;
  description: string | null;
  occurredAt: string;
  costCategory: { id: string; code: string; name: string };
  createdBy: Named | null;
}

/**
 * The four ledger states. None of them is good or bad news on its own — the
 * colour only separates them; the word says which.
 */
const LEDGER_TONES = { BUDGETED: '', COMMITTED: 'info', INCURRED: 'warn', CONSUMED: '' } as const;

function BudgetTab({ job, reloadToken }: { job: Job; reloadToken: number }) {
  const { can } = useAuth();
  const s = job.summary;
  const seesLedger = can('gops.budget_monitoring.view_all');

  return (
    <div className="stack">
      <section className="card">
        <h3 className="card-title">Budget monitoring</h3>

        <p className="muted del-lede">
          Available = budgeted − committed − incurred. Consumed is shown but not subtracted — stock
          issued to this job was already counted when it was received, and subtracting both would
          charge the same peso twice.
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
                <th className="del-col-meter">Used</th>
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
                  <td className={`right mono${p.available < 0 ? ' del-danger' : ''}`}>{formatMoney(p.available)}</td>
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

        <div className="alert info del-gap-top">
          Committed fills from approved purchase requests and issued orders; incurred from
          receiving, posted overtime, supplier bills with no receiving, and approved expense claims
          and liquidations.
        </div>
      </section>

      {seesLedger && <LedgerCard job={job} reloadToken={reloadToken} />}
    </div>
  );
}

/**
 * The ledger itself — every row that moved a column above, naming the
 * document behind it. Budget Monitoring is a view over this table; this is the
 * table.
 */
function LedgerCard({ job, reloadToken }: { job: Job; reloadToken: number }) {
  const [state, setState] = useState('');
  const [rows, setRows] = useState<LedgerRow[]>([]);
  const [page, setPage] = useState(1);
  const [pageCount, setPageCount] = useState(1);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    let live = true;
    setLoading(true);
    const q = `/jobs/${job.id}/ledger?pageSize=50&page=${page}${state ? `&state=${state}` : ''}`;
    api
      .get<ListResult<LedgerRow>>(q)
      .then((r) => {
        if (!live) return;
        setRows((prev) => (page === 1 ? r.rows : [...prev, ...r.rows]));
        setPageCount(r.pageCount);
        setTotal(r.total);
        setError(null);
      })
      .catch((err) => live && setError(err))
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, [job.id, state, page, reloadToken]);

  return (
    <section className="card">
      <div className="del-card-head">
        <h3 className="card-title">Cost ledger{total ? ` (${total})` : ''}</h3>
        <label className="row">
          <span className="faint del-small">Show</span>
          <select
            value={state}
            onChange={(e) => {
              setState(e.target.value);
              setPage(1);
            }}
          >
            <option value="">Every state</option>
            <option value="BUDGETED">Budgeted</option>
            <option value="COMMITTED">Committed</option>
            <option value="INCURRED">Incurred</option>
            <option value="CONSUMED">Consumed</option>
          </select>
        </label>
      </div>
      <p className="muted del-lede">
        Nothing here is edited or deleted. A released commitment is a negative row, so the ledger
        stays a history of what happened.
      </p>
      <ErrorBox error={error} />
      {rows.length === 0 && loading ? (
        <Loading />
      ) : rows.length === 0 ? (
        <p className="faint del-note">Nothing recorded{state ? ' in that state' : ''}.</p>
      ) : (
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>When</th>
                <th>State</th>
                <th>Budget line</th>
                <th>Source</th>
                <th>Detail</th>
                <th className="right">Amount</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const to = r.sourceId ? recordLink(r.sourceType, r.sourceId) : null;
                const label = r.sourceNumber ?? r.sourceType.replace(/_/g, ' ');
                return (
                  <tr key={r.id}>
                    <td className="muted">{formatDate(r.occurredAt)}</td>
                    <td>
                      <StatusBadge status={r.state} extra={LEDGER_TONES} />
                    </td>
                    <td>{r.costCategory.name}</td>
                    <td>{to ? <DocLink to={to}>{label}</DocLink> : <span className="mono">{label}</span>}</td>
                    <td>{r.description ?? <span className="faint">—</span>}</td>
                    <td className={`right mono${r.amount < 0 ? ' faint' : ''}`}>{formatMoney(r.amount)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {page < pageCount && (
        <div className="row del-gap-top">
          <button className="btn btn-sm" disabled={loading} onClick={() => setPage((p) => p + 1)}>
            {loading ? 'Loading…' : `Show more (${rows.length} of ${total})`}
          </button>
        </div>
      )}
    </section>
  );
}

// ── Plans ────────────────────────────────────────────────────────────────────

function PlansTab({
  job,
  onAdd,
  onChanged,
  confirm,
}: {
  job: Job;
  onAdd?: () => void;
  onChanged: () => Promise<void>;
  /** The page's confirm bar, under the project's header. */
  confirm: ConfirmApi;
}) {
  const { can } = useAuth();
  const toast = useToast();
  const [open, setOpen] = useState<string | null>(null);
  const mayApprove = can('gops.plans.edit_all');
  const mayAttach = can('gops.plans.create') || can('gops.plans.edit_all');

  /** Asked in the confirm bar first; a refusal is shown there. */
  function approve(plan: Job['plans'][number]) {
    const name = plan.drawingNo ? `${plan.drawingNo} rev ${plan.revision}` : `“${plan.title}” rev ${plan.revision}`;
    confirm.ask({
      title: `Approve ${name}?`,
      body: 'Work may start on it once it is approved.',
      confirmLabel: 'Approve',
      tone: 'primary',
      onConfirm: async () => {
        await api.patch(`/jobs/${job.id}/plans/${plan.id}`, { status: 'APPROVED' });
        toast('ok', 'Plan approved');
        await onChanged();
      },
    });
  }

  return (
    <section className="card">
      <div className="del-card-head">
        <h3 className="card-title">Approved plans</h3>
        {onAdd && (
          <button className="btn btn-sm" onClick={onAdd}>
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
                <th>
                  <span className="visually-hidden">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {job.plans.map((p) => (
                <PlanRow
                  key={p.id}
                  plan={p}
                  open={open === p.id}
                  onToggle={() => setOpen(open === p.id ? null : p.id)}
                  onApprove={mayApprove && p.status === 'FOR_APPROVAL' ? () => approve(p) : undefined}
                  mayAttach={mayAttach}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function PlanRow({
  plan: p,
  open,
  onToggle,
  onApprove,
  mayAttach,
}: {
  plan: Job['plans'][number];
  open: boolean;
  onToggle: () => void;
  onApprove?: () => void;
  mayAttach: boolean;
}) {
  return (
    <>
      <tr>
        <td className="mono">{p.drawingNo ?? '—'}</td>
        <td>{p.title}</td>
        <td className="mono">{p.revision}</td>
        <td>{p.discipline ?? '—'}</td>
        <td>
          <StatusBadge status={p.status} extra={PLAN_TONES} />
        </td>
        <td className="muted">
          {p.approvedAt ? `${formatDate(p.approvedAt)}${p.approvedBy ? ` · ${p.approvedBy}` : ''}` : '—'}
        </td>
        <td>
          <div className="row">
            <button
              type="button"
              className="btn btn-sm btn-ghost"
              aria-expanded={open}
              aria-controls={`plan-files-${p.id}`}
              onClick={onToggle}
            >
              Files
            </button>
            {onApprove && (
              <button className="btn btn-sm" onClick={onApprove}>
                Approve
              </button>
            )}
          </div>
        </td>
      </tr>
      {open && (
        <tr className="del-expand-row">
          <td colSpan={7} id={`plan-files-${p.id}`}>
            <Attachments
              entityType="approved_plan"
              entityId={p.id}
              title={`Files — ${p.drawingNo ?? p.title} rev ${p.revision}`}
              hint="The drawing itself, and the approval stamp or transmittal that went with it."
              canEdit={mayAttach}
            />
          </td>
        </tr>
      )}
    </>
  );
}

// ── Tasks ────────────────────────────────────────────────────────────────────

/** A meeting held for this project — GET /meetings?jobId=, the list's own row. */
interface ProjectMeeting {
  id: string;
  number: string;
  title: string;
  location: string | null;
  startsAt: string;
  status: string;
  organizer: { id: string; name: string };
}

/**
 * Meetings & Records (2026-10-06): the meetings held for this project — a
 * kick-off, site meetings, the turnover — above its documents and its
 * activity. Shown only to someone who may read meetings at all; the list
 * route narrows a view_own holder to the meetings they are on.
 */
function ProjectMeetingsCard({ job }: { job: Job }) {
  const { can } = useAuth();
  const [rows, setRows] = useState<ProjectMeeting[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const sees = can('ghr.meetings.view_all') || can('ghr.meetings.view_own');

  useEffect(() => {
    if (!sees) return;
    api
      .get<ListResult<ProjectMeeting>>(`/meetings?jobId=${job.id}&pageSize=100`)
      .then((r) => setRows(r.rows))
      .catch(setError);
  }, [job.id, sees]);

  if (!sees) return null;
  return (
    <section className="card">
      <div className="del-card-head">
        <h3 className="card-title">Meetings{rows && rows.length ? ` (${rows.length})` : ''}</h3>
        {can('ghr.meetings.create') && (
          <Link className="btn btn-primary btn-sm" to={`/g-hr/meetings?new=1&job=${job.id}`}>
            + New meeting
          </Link>
        )}
      </div>
      <p className="muted del-lede">
        Kick-off, site and turnover meetings held for this project. Minutes and other records go in the documents
        below.
      </p>
      <ErrorBox error={error} />
      {!rows && !error ? (
        <Loading />
      ) : rows && rows.length === 0 ? (
        <p className="faint del-note">No meeting has been held for this project yet.</p>
      ) : rows ? (
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>Number</th>
                <th>Meeting</th>
                <th>When</th>
                <th>Organiser</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((m) => (
                <tr key={m.id}>
                  <td>
                    <Link className="mono" to={`/g-hr/meetings/${m.id}`}>
                      {m.number}
                    </Link>
                  </td>
                  <td>
                    {m.title}
                    {m.location && <div className="faint">{m.location}</div>}
                  </td>
                  <td>{formatDateTime(m.startsAt)}</td>
                  <td>{m.organizer.name}</td>
                  <td>
                    <StatusBadge status={m.status} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </section>
  );
}

// ── Modals ───────────────────────────────────────────────────────────────────

function EditJobModal({ job, onClose, onSaved }: { job: Job; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [people, setPeople] = useState<{ id: string; name: string; position: string | null }[]>([]);
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
    // Naming a project manager is not the admin right to list users.
    api
      .get<{ id: string; name: string; position: string | null }[]>('/users/lookup')
      .then(setPeople)
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
      title={`Modify ${job.type === 'SERVICE_CONTRACT' ? 'service contract' : 'project'} ${job.number}`}
      onClose={onClose}
      footer={
        <ModalFoot onCancel={onClose} busy={busy}>
          <button className="btn btn-primary" onClick={save} disabled={busy}>
            {busy ? 'Saving…' : 'Save'}
          </button>
        </ModalFoot>
      }
    >
      <ErrorBox error={error} />
      <div className="grid grid-2">
        <Field label="Project name">
          <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        </Field>
        <Field
          label="Status"
          hint={job.status === 'COMPLETED' ? 'Use Turn over on the page to register the equipment in the same step' : undefined}
        >
          {/* Putting on hold and cancelling are ⋯ items on the page, each
              asking first; the job's own status still shows when it is one. */}
          <select value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value })}>
            {JOB_STATUSES.filter(
              (st) => (st.value !== 'ON_HOLD' && st.value !== 'CANCELLED') || st.value === job.status,
            ).map((st) => (
              <option key={st.value} value={st.value}>
                {st.label}
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
                {p.position ? ` — ${p.position}` : ''}
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
        <Field label="Actual end">
          <input
            type="date"
            value={form.actualEndDate}
            onChange={(e) => setForm({ ...form, actualEndDate: e.target.value })}
          />
        </Field>
      </div>
      <Field label="Notes">
        <textarea value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
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
    : (job.startDate?.slice(0, 10) ?? todayLocal());

  const [form, setForm] = useState({
    periodFrom: defaultFrom,
    periodTo: todayLocal(),
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
        <ModalFoot onCancel={onClose} busy={busy}>
          <button className="btn btn-primary" onClick={create} disabled={busy}>
            {busy ? 'Saving…' : 'Save'}
          </button>
        </ModalFoot>
      }
    >
      <ErrorBox error={error} />
      <p className="muted del-lede">
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
      title="Add plan"
      onClose={onClose}
      footer={
        <ModalFoot onCancel={onClose} busy={busy}>
          <button className="btn btn-primary" onClick={save} disabled={busy || form.title.length < 2}>
            {busy ? 'Saving…' : 'Save'}
          </button>
        </ModalFoot>
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
      <p className="faint del-note">
        Attach the drawing from the plan's <em>Files</em> once it is registered. A plan starts as{' '}
        <em>for approval</em> — work should not begin until it is approved.
      </p>
    </Modal>
  );
}

// ── Turnover ─────────────────────────────────────────────────────────────────

interface AssetDraft {
  key: number;
  name: string;
  manufacturer: string;
  model: string;
  serialNo: string;
  capacity: string;
  location: string;
}

const blankAsset = (key: number): AssetDraft => ({
  key,
  name: '',
  manufacturer: '',
  model: '',
  serialNo: '',
  capacity: '',
  location: '',
});

/**
 * Turning a project over, and registering what it installed in the same act.
 *
 * "A turned-over project generates a PM schedule and a signed PM report"
 * starts here: without the register there is nothing to schedule against or
 * renew, and asking somebody to key the equipment later means it never
 * happens. The warranty clock starts on the installed date.
 *
 * The equipment is registered first and the status moved second. If the
 * second step fails the equipment is still recorded, the job stays COMPLETED,
 * and the modal says so — rather than a TURNED_OVER job with nothing behind it.
 */
function TurnoverModal({
  job,
  mode,
  onClose,
  onDone,
}: {
  job: Job;
  mode: 'turnover' | 'register';
  onClose: () => void;
  onDone: () => void;
}) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [rows, setRows] = useState<AssetDraft[]>([blankAsset(1)]);
  const [nextKey, setNextKey] = useState(2);
  const [installedAt, setInstalledAt] = useState(job.actualEndDate?.slice(0, 10) ?? todayLocal());
  const [warrantyMonths, setWarrantyMonths] = useState('12');
  const [registered, setRegistered] = useState(false);

  useEffect(() => {
    api
      .get<{ defaultWarrantyMonths: number }>('/aftermarket/settings')
      .then((s) => setWarrantyMonths(String(s.defaultWarrantyMonths)))
      .catch(() => {});
  }, []);

  const filled = rows.filter((r) => r.name.trim().length >= 2);
  const half = rows.filter((r) => r.name.trim().length > 0 && r.name.trim().length < 2);

  function update(key: number, field: keyof Omit<AssetDraft, 'key'>, value: string) {
    setRows((list) => list.map((r) => (r.key === key ? { ...r, [field]: value } : r)));
  }

  async function finish() {
    setBusy(true);
    setError(null);
    try {
      if (filled.length && !registered) {
        await api.post(`/installed-assets/from-job/${job.id}`, {
          assets: filled.map((r) => ({
            name: r.name.trim(),
            manufacturer: r.manufacturer || null,
            model: r.model || null,
            serialNo: r.serialNo || null,
            capacity: r.capacity || null,
            location: r.location || null,
          })),
          installedAt,
          warrantyMonths: Number(warrantyMonths),
        });
        setRegistered(true);
      }
      if (mode === 'turnover') {
        await api.patch(`/jobs/${job.id}`, { status: 'TURNED_OVER' });
      }
      toast(
        'ok',
        mode === 'turnover'
          ? filled.length
            ? `Turned over — ${filled.length} item(s) registered in the installed base`
            : 'Turned over'
          : `${filled.length} item(s) registered in the installed base`,
      );
      onDone();
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  }

  const canFinish =
    !busy &&
    half.length === 0 &&
    (mode === 'turnover' || filled.length > 0) &&
    installedAt !== '' &&
    Number(warrantyMonths) >= 0;

  return (
    <Modal
      wide
      title={mode === 'turnover' ? `Turn over ${job.number}` : 'Add equipment'}
      onClose={onClose}
      footer={
        <ModalFoot onCancel={onClose} busy={busy}>
          <button className="btn btn-primary" onClick={finish} disabled={!canFinish}>
            {busy
              ? 'Saving…'
              : mode === 'turnover'
                ? filled.length
                  ? `Register ${filled.length} and turn over`
                  : 'Turn over without equipment'
                : 'Save'}
          </button>
        </ModalFoot>
      }
    >
      <ErrorBox error={error} />
      {registered && (
        <div className="alert warn">
          The equipment is registered. The project could not be moved to Turned over — try again, or
          set the status from Modify.
        </div>
      )}
      <p className="muted del-lede">
        {mode === 'turnover'
          ? 'List what this project installed. Each item enters the installed base under this customer and site, with its warranty running from the installed date — that register is what PM schedules and renewals are built from.'
          : 'Add equipment this project installed that was not registered at turnover.'}
      </p>

      <div className="grid grid-2">
        <Field label="Installed on">
          <input type="date" value={installedAt} onChange={(e) => setInstalledAt(e.target.value)} />
        </Field>
        <Field label="Warranty (months)" hint="From the installed date. The aftermarket default is filled in">
          <NumberInput
            kind="count"
            min={0}
            max={240}
            value={warrantyMonths}
            onChange={(e) => setWarrantyMonths(e.target.value)}
          />
        </Field>
      </div>

      <div className="table-wrap del-turnover">
        <table className="data">
          <thead>
            <tr>
              <th>Equipment</th>
              <th>Manufacturer</th>
              <th>Model</th>
              <th>Serial no.</th>
              <th>Capacity</th>
              <th>Location</th>
              <th>
                <span className="visually-hidden">Remove</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={r.key}>
                <td>
                  <input
                    aria-label={`Equipment ${i + 1} name`}
                    value={r.name}
                    placeholder="PSA oxygen generator"
                    onChange={(e) => update(r.key, 'name', e.target.value)}
                  />
                </td>
                <td>
                  <input
                    aria-label={`Equipment ${i + 1} manufacturer`}
                    value={r.manufacturer}
                    onChange={(e) => update(r.key, 'manufacturer', e.target.value)}
                  />
                </td>
                <td>
                  <input
                    aria-label={`Equipment ${i + 1} model`}
                    value={r.model}
                    onChange={(e) => update(r.key, 'model', e.target.value)}
                  />
                </td>
                <td>
                  <input
                    className="mono"
                    aria-label={`Equipment ${i + 1} serial number`}
                    value={r.serialNo}
                    onChange={(e) => update(r.key, 'serialNo', e.target.value)}
                  />
                </td>
                <td>
                  <input
                    aria-label={`Equipment ${i + 1} capacity`}
                    value={r.capacity}
                    placeholder="20 Nm³/h"
                    onChange={(e) => update(r.key, 'capacity', e.target.value)}
                  />
                </td>
                <td>
                  <input
                    aria-label={`Equipment ${i + 1} location`}
                    value={r.location}
                    placeholder="Plant room"
                    onChange={(e) => update(r.key, 'location', e.target.value)}
                  />
                </td>
                <td>
                  <button
                    type="button"
                    className="btn btn-sm btn-ghost"
                    aria-label={`Remove equipment ${i + 1}`}
                    disabled={rows.length === 1}
                    onClick={() => setRows((list) => list.filter((x) => x.key !== r.key))}
                  >
                    ×
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="row del-gap-top">
        <button
          type="button"
          className="btn btn-sm"
          onClick={() => {
            setRows((list) => [...list, blankAsset(nextKey)]);
            setNextKey((k) => k + 1);
          }}
        >
          + Add equipment
        </button>
        {half.length > 0 && <span className="faint del-small">Name each item, or remove the row.</span>}
      </div>
    </Modal>
  );
}
