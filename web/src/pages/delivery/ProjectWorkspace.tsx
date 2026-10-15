import { useCallback, useEffect, useId, useState, type ReactNode } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { CommissionsCard } from '../finance/Commissions';
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
import { useConfirm } from '../../components/Confirm';
import { recordLink } from '../../lib/links';
import { SCurve, type CurvePoint } from './SCurve';
import { ProjectGantt } from './ProjectGantt';
import { JOB_STATUSES, JOB_TONES, ProgressBar } from './Projects';
import { todayLocal } from '../../lib/day';
import { NumberInput } from '../../components/NumberInput';
import { PersonSelect, usePeople } from '../../components/People';
import { ProjectBudgetRequestsCard, BudgetRequestModal } from './BudgetRequests';
import { ProjectPlanApprovalsCard } from './PlanApprovals';
import { ProjectCostingCard } from './ProjectCosting';
import { ProjectJobOrders } from '../service/JobOrders';
import { REQUEST_TONES } from '../finance/InvoiceRequests';

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
  /** Whether the dates tally with the scope of work: its last planned day, and working days (Mon–Sat) to it and to the target end. */
  schedule?: { planFinish: string | null; planDays: number | null; targetDays: number | null };
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
    billing: { id: string } | null;
  }[];
  billings: {
    id: string;
    number: string;
    billingNo: number;
    status: string;
    billingDate: string;
    grossAmount: number;
    netCollectible: number;
    /** Beside each billing, its invoice and its latest invoice request (2026-10-15). */
    invoice: { id: string; number: string; status: string } | null;
    invoiceRequests: { id: string; number: string; status: string }[];
  }[];
  /** The project's Requests for Approval (2026-10-13). */
  plans: {
    id: string;
    number: string | null;
    title: string;
    drawingNo: string | null;
    revision: string;
    discipline: string | null;
    status: string;
    approvedAt: string | null;
    approvedBy: string | null;
    createdAt: string;
    uploadedBy: { id: string; name: string } | null;
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
  | 'costing'
  | 'joborders'
  | 'requests'
  | 'scope'
  | 'progress';

/**
 * The owner's order (2026-10-06), after the old gasiontech G-CORE's project
 * menu: Overview, Meetings & Records, Request for Approval, Budget Monitoring,
 * Purchase Requisition, Budget Requests, Scope of Work (the Gantt chart),
 * Progress & Billing. Finance and Service went on 2026-10-15 (the owner's
 * call): the invoices sit beside their billings on Progress & Billing, and
 * the equipment installed opens Aftermarket's Installed Base from the overview. Costing and Job
 * Orders follow Overview (2026-10-15, the owner's call): the costing the
 * project was built from, and the job orders raised for it.
 */
const TABS: Tab[] = ['overview', 'costing', 'joborders', 'meetings', 'plans', 'budget', 'procurement', 'requests', 'scope', 'progress'];

/** Where the tabs that used to exist went, so an old link or notification still lands. */
const TAB_ALIASES: Record<string, Tab> = {
  billing: 'progress',
  tasks: 'scope',
  documents: 'meetings',
  activity: 'meetings',
  // The tabs removed on 2026-10-15.
  finance: 'progress',
  service: 'overview',
};

/** Plan statuses the shared rules do not already colour. */
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
  const visible: Record<Tab, boolean> = {
    overview: true,
    costing: true,
    joborders: can('gops.job_orders.view_all') || can('gops.job_orders.view_own'),
    meetings: true,
    plans: true,
    budget: true,
    procurement: procurementKeys.some(can),
    requests: can('gops.budget_requests.view_all') || can('gops.budget_requests.view_own'),
    scope: true,
    progress: true,
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
    costing: 'Costing',
    joborders: 'Job Orders',
    meetings: 'Meetings & Records',
    plans: `Request for Approval (${job.plans.length})`,
    budget: 'Budget Monitoring',
    procurement: 'Purchase Requisition',
    requests: `Budget Requests (${job.budgetRequestCount})`,
    scope: 'Scope of Work (Gantt)',
    progress: `Progress & Billing (${job.progressReports.length})`,
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
            {job.projectManager ? ` · Technical Manager ${job.projectManager.name}` : ' · no Technical Manager'}
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
          // Equipment this project installed that was not registered at
          // turnover (the Service tab's button until 2026-10-15).
          mayRegister &&
            job.status === 'TURNED_OVER' && {
              label: 'Add equipment',
              onSelect: () => setTurnover('register'),
            },
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
          job.status === 'CANCELLED' &&
            can('gops.projects.delete') && {
              label: 'Delete',
              danger: true,
              confirm: {
                title: `Delete ${job.number}?`,
                body: 'This cancelled project goes for good, with its scope, tasks, reports and ledger. Refused while an invoice, bill, PR, PO, stock issue, claim, advance or released budget request is filed against it. Its number is not reused.',
                confirmLabel: 'Delete',
                onConfirm: async () => {
                  await api.del(`/jobs/${job.id}`);
                  toast('ok', `${job.number} deleted`);
                  navigate('/g-ops/projects');
                },
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
              {/* The number, the costing and the quotation are the header's (rule 19: lineage in the meta line). */}
              <Row label="Type" value={job.type === 'PROJECT' ? 'Project' : 'Service contract'} />
              <Row label="Customer P.O." value={job.customerPoNumber} />
              <Row label="P.O. date" value={job.customerPoDate ? formatDate(job.customerPoDate) : null} />
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
              <Row
                label="Target end"
                value={
                  job.targetEndDate ? (
                    <>
                      {formatDate(job.targetEndDate)}
                      {job.schedule?.targetDays != null && (
                        <span className="muted"> · {job.schedule.targetDays} working days (Mon–Sat)</span>
                      )}
                    </>
                  ) : null
                }
              />
              {job.schedule?.planFinish && (
                <Row
                  label="Scope of work ends"
                  value={
                    <>
                      {formatDate(job.schedule.planFinish)}
                      {job.schedule.planDays != null && <span className="muted"> · {job.schedule.planDays} working days</span>}
                      {job.schedule.targetDays != null &&
                        job.schedule.planDays != null &&
                        job.schedule.targetDays !== job.schedule.planDays && (
                          <div className="hint">
                            The target end is {job.schedule.targetDays} working days after the start — the scope of work plans{' '}
                            {job.schedule.planDays}.
                          </div>
                        )}
                    </>
                  }
                />
              )}
              <Row label="Actual end" value={job.actualEndDate ? formatDate(job.actualEndDate) : null} />
              <Row label="Technical Manager" value={job.projectManager?.name} />
              {job.installedAssetCount > 0 && (
                <Row
                  label="Equipment installed"
                  value={
                    can('gops.installed_base.view_all') ? (
                      <Link to={`/g-ops/installed-base?jobId=${job.id}`}>{job.installedAssetCount} in the Installed Base ↗</Link>
                    ) : (
                      job.installedAssetCount
                    )
                  }
                />
              )}
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

      {current === 'costing' && <ProjectCostingCard costing={job.costing} />}

      {current === 'joborders' && (
        <ProjectJobOrders jobId={job.id} customerId={job.customer.id} quotationId={job.quotationRevision?.quotation.id ?? null} />
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

      {current === 'plans' && <ProjectPlanApprovalsCard job={job} plans={job.plans} onChanged={() => void load()} />}

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
        <ProgressBillingsCard job={job} totalBilled={s.billed} onChanged={() => void load()} />
        <CommissionsCard jobId={job.id} />
        </div>
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
/**
 * Under the progress reports, the project's billings (2026-10-15, the owner's
 * call): "+ New progress billing" bills an approved report not yet billed (the
 * same `POST /billings` as the report page's Raise billing), and each billing
 * shows its invoice request and its invoice — the invoices live here since the
 * Finance tab went. "Request invoice" opens the billing, where the salesperson
 * or Team Leader holding the project asks for it.
 */
function ProgressBillingsCard({ job, totalBilled, onChanged }: { job: Job; totalBilled: number; onChanged: () => void }) {
  const { can } = useAuth();
  const navigate = useNavigate();
  const toast = useToast();
  const [picking, setPicking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const unbilled = job.progressReports.filter((r) => r.status === 'APPROVED' && !r.billing);

  async function bill(reportId: string) {
    setBusy(true);
    setError(null);
    try {
      const made = await api.post<{ id: string; number: string }>('/billings', { progressReportId: reportId });
      toast('ok', `${made.number} raised — submit it for approval`);
      onChanged();
      navigate(`/g-ops/billings/${made.id}`);
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  }

  return (
    <div className="card">
      <div className="del-card-head">
        <h3 className="card-title">Progress billings</h3>
        {can('gops.progress_billing.create') && (
          <button
            className="btn btn-primary btn-sm"
            disabled={unbilled.length === 0 || busy}
            title={unbilled.length === 0 ? 'Every approved report is billed — approve the next report first' : undefined}
            onClick={() => (unbilled.length === 1 ? bill(unbilled[0].id) : setPicking((p) => !p))}
          >
            + New progress billing
          </button>
        )}
      </div>
      <p className="muted del-lede">
        Raised from an approved progress report, never keyed by hand, and approved by the Technical Manager and the Team
        Leader. Then the salesperson or Team Leader requests the invoice: Back Support approves it, and the draft invoice
        lands in Accounts Receivable.
      </p>
      <ErrorBox error={error} />
      {picking && unbilled.length > 1 && (
        <div className="alert info">
          Which approved report?{' '}
          {unbilled.map((r) => (
            <button key={r.id} className="btn btn-sm" disabled={busy} onClick={() => bill(r.id)}>
              {r.number} · {formatDate(r.periodFrom)} — {formatDate(r.periodTo)}
            </button>
          ))}
        </div>
      )}
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
                <th>Invoice request</th>
                <th>Invoice</th>
              </tr>
            </thead>
            <tbody>
              {job.billings.map((b) => {
                const req = b.invoiceRequests[0];
                return (
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
                    <td>
                      {req ? (
                        <>
                          <Link className="mono" to={`/g-fin/invoice-requests/${req.id}`}>
                            {req.number}
                          </Link>
                          <div>
                            <StatusBadge status={req.status} extra={REQUEST_TONES} />
                          </div>
                        </>
                      ) : b.status === 'APPROVED' && !b.invoice && can('gfin.invoice_requests.create') ? (
                        <Link className="btn btn-sm" to={`/g-ops/billings/${b.id}`}>
                          Request invoice
                        </Link>
                      ) : (
                        <span className="faint">—</span>
                      )}
                    </td>
                    <td>
                      {b.invoice ? (
                        can('gfin.ar.view_all') ? (
                          <>
                            <Link className="mono" to={`/g-fin/ar/${b.invoice.id}`}>
                              {b.invoice.number}
                            </Link>
                            <div>
                              <StatusBadge status={b.invoice.status} />
                            </div>
                          </>
                        ) : (
                          <span className="mono">{b.invoice.number}</span>
                        )
                      ) : (
                        <span className="faint">—</span>
                      )}
                    </td>
                  </tr>
                );
              })}
              <tr>
                <td colSpan={3} className="right">
                  <strong>TOTAL BILLED</strong>
                </td>
                <td className="right mono">
                  <strong>{formatMoney(totalBilled)}</strong>
                </td>
                <td colSpan={4} />
              </tr>
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

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
              <Link className="btn btn-primary btn-sm" to={`/g-ops/purchase-requests/new?jobId=${job.id}`}>
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
            { label: 'Number', render: (r) => <DocLink to={`/g-chain/incoming/${r.id}`}>{r.number}</DocLink> },
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
            { label: 'Number', render: (r) => <DocLink to={`/g-chain/outgoing/${r.id}`}>{r.number}</DocLink> },
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
  /** Minutes have been written (2026-10-13) — the trail at a glance. */
  hasMinutes?: boolean;
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
        Kick-off, site and turnover meetings held for this project — each with its minutes of meeting, so anyone can
        look back on what was discussed. Other records go in the documents below.
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
                <th>Minutes</th>
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
                  <td>{m.hasMinutes ? '✓ Written' : <span className="faint">—</span>}</td>
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
  // The project's manager is its Technical Manager; naming one is not the admin right to list users.
  const { people } = usePeople('role:technical_manager');
  const pmId = useId();
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
        <Field label="Technical Manager" htmlFor={pmId}>
          <PersonSelect
            id={pmId}
            value={form.projectManagerId}
            onChange={(id) => setForm((f) => ({ ...f, projectManagerId: id }))}
            people={people}
            placeholder="— unassigned —"
            current={job.projectManager}
          />
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
