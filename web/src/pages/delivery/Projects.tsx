import { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { DataList, type Column } from '../../components/DataList';
import {
  ErrorBox,
  Field,
  Modal,
  StatusBadge,
  formatDate,
  formatMoney,
  useToast,
  type Tone,
} from '../../components/ui';
import { Meter as ProgressBar } from '../../components/charts';
import { todayLocal } from '../../lib/day';

export const JOB_STATUSES = [
  { value: 'PLANNING', label: 'Planning' },
  { value: 'IN_PROGRESS', label: 'In progress' },
  { value: 'ON_HOLD', label: 'On hold' },
  { value: 'COMPLETED', label: 'Completed' },
  { value: 'TURNED_OVER', label: 'Turned over' },
  { value: 'CANCELLED', label: 'Cancelled' },
];

/**
 * A job's own statuses, as the `extra` map for the one StatusBadge. Work under
 * way reads as information, a paused job as a warning; the rest follow the
 * shared lifecycle rules.
 */
export const JOB_TONES: Record<string, Tone> = {
  PLANNING: '',
  IN_PROGRESS: 'info',
  ON_HOLD: 'warn',
  COMPLETED: 'ok',
  TURNED_OVER: 'ok',
};

/** The status pill for a job, with its own wording. */
export function JobStatus({ status }: { status: string }) {
  return (
    <StatusBadge
      status={status}
      extra={JOB_TONES}
      label={JOB_STATUSES.find((s) => s.value === status)?.label}
    />
  );
}

/**
 * The percentage bar, under the name eight screens already import. The body
 * lives in components/charts.tsx now — there were two implementations of this
 * and they did not look the same.
 */
export { ProgressBar };

interface JobRow {
  id: string;
  number: string;
  type: string;
  status: string;
  name: string;
  customer: { id: string; name: string };
  site: { id: string; name: string } | null;
  projectManager: { id: string; name: string } | null;
  contractValue: number;
  actualCost: number;
  grossProfit: number;
  grossMarginPct: number;
  expectedMarginPct: number;
  billed: number;
  progressPct: number;
  startDate: string | null;
  targetEndDate: string | null;
}

/** What the URL can hand the new-project form — see NewJobModal. */
export interface NewJobPreset {
  costingId?: string;
  quotationRevisionId?: string;
  type?: string;
  renewFrom?: string;
}

/** The URL keys the new-project form reads, removed again when it closes. */
const PRESET_KEYS = ['new', 'costingId', 'quotationRevisionId', 'type', 'renewFrom'] as const;

export function Projects() {
  const { can } = useAuth();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const [creating, setCreating] = useState(false);
  const [reload, setReload] = useState(0);

  /*
    `?new=1` opens the form, prefilled from whatever came with it. The
    quotation's "Create project", the costing's "Where this goes next" and a
    contract renewal all land here, so nothing that is already on a record is
    typed again (model §4.1).
  */
  const fromUrl = params.get('new') === '1' && can('gops.projects.create');
  const preset: NewJobPreset = fromUrl
    ? {
        costingId: params.get('costingId') ?? undefined,
        quotationRevisionId: params.get('quotationRevisionId') ?? undefined,
        type: params.get('type') ?? undefined,
        renewFrom: params.get('renewFrom') ?? undefined,
      }
    : {};

  function closeForm() {
    setCreating(false);
    if (PRESET_KEYS.some((k) => params.has(k))) {
      const next = new URLSearchParams(params);
      for (const k of PRESET_KEYS) next.delete(k);
      setParams(next, { replace: true });
    }
  }

  const columns: Column<JobRow>[] = [
    { key: 'number', label: 'Number', sortKey: 'number', render: (j) => <span className="mono">{j.number}</span> },
    {
      key: 'name',
      label: 'Project',
      sortKey: 'name',
      render: (j) => (
        <div>
          <div>{j.name}</div>
          <div className="faint">
            {j.customer.name}
            {j.site ? ` · ${j.site.name}` : ''}
          </div>
        </div>
      ),
    },
    {
      key: 'progress',
      label: 'Progress',
      render: (j) => <ProgressBar pct={j.progressPct} />,
    },
    {
      key: 'contractValue',
      label: 'Contract',
      sortKey: 'contractValue',
      align: 'right',
      render: (j) => <span className="mono">{formatMoney(j.contractValue)}</span>,
    },
    {
      key: 'billed',
      label: 'Billed',
      align: 'right',
      render: (j) => <span className="mono">{formatMoney(j.billed)}</span>,
    },
    {
      key: 'actualCost',
      label: 'Cost',
      align: 'right',
      render: (j) => <span className="mono">{formatMoney(j.actualCost)}</span>,
      optional: true,
    },
    {
      key: 'margin',
      label: 'Margin',
      align: 'right',
      // Expected margin from the costing — margin computed from spend-so-far
      // reads 100% on a job that has barely started.
      render: (j) => (
        <span
          className={`badge ${j.expectedMarginPct < 0 ? 'danger' : j.expectedMarginPct < 10 ? 'warn' : 'ok'}`}
          title="Expected margin, from the costing"
        >
          {j.expectedMarginPct.toFixed(1)}%
        </span>
      ),
    },
    { key: 'pm', label: 'Manager', render: (j) => j.projectManager?.name ?? <span className="faint">unassigned</span> },
    { key: 'targetEndDate', label: 'Target end', render: (j) => formatDate(j.targetEndDate), optional: true },
    {
      key: 'status',
      label: 'Status',
      render: (j) => <JobStatus status={j.status} />,
    },
  ];

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Projects</h1>
          <p>
            A project is created from a costing, which carries across its budget and its schedule
            of values. Cost shown here is committed plus incurred — what you have promised plus what
            you already owe.
          </p>
        </div>
      </div>

      {/* The registers across every project (2026-10-06): off the menu — each
          is a tab inside a project — but kept one click away here. */}
      <p className="del-registers">
        {(can('gops.plans.view_all') || can('gops.plans.view_own')) && <Link to="/g-ops/plans">Approved plans</Link>}
        {can('gops.budget_monitoring.view_all') && <Link to="/g-ops/budget-monitoring">Budget monitoring</Link>}
        {(can('gops.purchase_requests.view_all') || can('gops.purchase_requests.view_own')) && (
          <Link to="/g-ops/purchase-requests">Purchase requests</Link>
        )}
        {(can('gops.budget_requests.view_all') || can('gops.budget_requests.view_own')) && (
          <Link to="/g-ops/budget-requests">Budget requests</Link>
        )}
        {(can('gops.progress_billing.view_all') || can('gops.progress_billing.view_own')) && (
          <Link to="/g-ops/progress">Progress &amp; billing</Link>
        )}
      </p>

      <DataList<JobRow>
        listKey="projects"
        endpoint="/jobs"
        columns={columns}
        rowKey={(j) => j.id}
        scoped
        searchPlaceholder="Search name, number, customer, P.O.…"
        reloadToken={reload}
        onRowClick={(j) => navigate(`/g-ops/projects/${j.id}`)}
        emptyTitle="No projects yet"
        emptyHint="Create one from an approved quotation's costing."
        filters={[
          { key: 'status', label: 'Status', options: JOB_STATUSES },
          {
            key: 'type',
            label: 'Type',
            options: [
              { value: 'PROJECT', label: 'Project' },
              { value: 'SERVICE_CONTRACT', label: 'Service contract' },
            ],
          },
        ]}
        actions={
          can('gops.projects.create') ? (
            <button className="btn btn-primary btn-sm" onClick={() => setCreating(true)}>
              + New project
            </button>
          ) : null
        }
      />

      {(creating || fromUrl) && (
        <NewJobModal
          preset={preset}
          onClose={closeForm}
          onCreated={(id) => {
            setCreating(false);
            setReload((r) => r + 1);
            navigate(`/g-ops/projects/${id}`);
          }}
        />
      )}
    </div>
  );
}

interface CostingOption {
  id: string;
  number: string;
  title: string;
  contractValue: number;
}

interface CostingDetail {
  id: string;
  number: string;
  title: string;
  status: string;
  contractValue: number;
  customer: { id: string; name: string } | null;
  site: { id: string; name: string } | null;
  quotationRevisions: {
    id: string;
    revision: number;
    status: string;
    quotation: { id: string; number: string; subject: string };
  }[];
  jobs: { id: string; number: string; name: string; status: string }[];
}

interface PersonRow {
  id: string;
  name: string;
  position: string | null;
}

function NewJobModal({
  preset,
  onClose,
  onCreated,
}: {
  preset: NewJobPreset;
  onClose: () => void;
  onCreated: (id: string) => void;
}) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [costings, setCostings] = useState<CostingOption[]>([]);
  const [customers, setCustomers] = useState<{ id: string; name: string }[]>([]);
  const [sites, setSites] = useState<{ id: string; name: string }[]>([]);
  const [people, setPeople] = useState<PersonRow[]>([]);
  const [chosen, setChosen] = useState<CostingDetail | null>(null);
  const [renewal, setRenewal] = useState<{ id: string; number: string } | null>(null);

  const renewing = !!preset.renewFrom;
  const [form, setForm] = useState({
    costingId: '',
    quotationRevisionId: preset.quotationRevisionId ?? '',
    name: '',
    // A renewal is a service contract whatever the URL says; the server forces
    // it too.
    type: renewing ? 'SERVICE_CONTRACT' : preset.type === 'SERVICE_CONTRACT' ? 'SERVICE_CONTRACT' : 'PROJECT',
    customerId: '',
    siteId: '',
    projectManagerId: '',
    customerPoNumber: '',
    customerPoDate: '',
    startDate: todayLocal(),
  });

  useEffect(() => {
    // Final costings only: a draft's budget is still moving, and a project
    // snapshots it. A preset costing is added below even if it is a draft, so
    // the renewal flow (duplicate → reprice → create) can still land here.
    api.get<CostingOption[]>('/costings/lookup?status=FINAL').then(setCostings).catch(() => {});
    api.get<typeof customers>('/customers/lookup').then(setCustomers).catch(() => {});
    api.get<PersonRow[]>('/users/lookup').then(setPeople).catch(() => {});
  }, []);

  useEffect(() => {
    if (preset.costingId) void pickCosting(preset.costingId);
    if (preset.renewFrom) {
      api
        .get<{ id: string; number: string }>(`/service-contracts/${preset.renewFrom}`)
        .then((c) => setRenewal({ id: c.id, number: c.number }))
        .catch(() => setRenewal(null));
    }
    // Run once, for the preset the form opened with.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!form.customerId) {
      setSites([]);
      return;
    }
    api
      .get<{ sites: { id: string; name: string }[] }>(`/customers/${form.customerId}`)
      .then((c) => setSites(c.sites))
      .catch(() => setSites([]));
  }, [form.customerId]);

  /**
   * Choosing a costing fills the name, the customer and the site. The customer
   * is then LOCKED: a project takes its customer from its costing, and the API
   * refuses a mismatch — the form should not offer one.
   */
  async function pickCosting(costingId: string) {
    setForm((f) => ({ ...f, costingId }));
    if (!costingId) {
      setChosen(null);
      return;
    }
    try {
      const c = await api.get<CostingDetail>(`/costings/${costingId}`);
      setChosen(c);
      setCostings((list) =>
        list.some((x) => x.id === c.id)
          ? list
          : [{ id: c.id, number: c.number, title: c.title, contractValue: c.contractValue }, ...list],
      );
      // The quotation this project delivers: the preset, else the costing's
      // single approved revision when there is exactly one to choose.
      const approved = c.quotationRevisions.filter((r) => r.status === 'APPROVED');
      setForm((f) => ({
        ...f,
        name: f.name || c.title,
        customerId: c.customer?.id ?? f.customerId,
        siteId: c.site?.id ?? (c.customer ? '' : f.siteId),
        quotationRevisionId:
          f.quotationRevisionId || (approved.length === 1 ? approved[0].id : ''),
      }));
    } catch {
      /* the create call will report anything wrong */
    }
  }

  async function create() {
    setBusy(true);
    setError(null);
    try {
      const created = await api.post<{ id: string; serviceContractId: string | null }>('/jobs', {
        costingId: form.costingId,
        quotationRevisionId: form.quotationRevisionId || null,
        name: form.name,
        type: form.type,
        customerId: form.customerId,
        siteId: form.siteId || null,
        projectManagerId: form.projectManagerId || null,
        customerPoNumber: form.customerPoNumber || null,
        customerPoDate: form.customerPoDate || null,
        startDate: form.startDate || null,
        renewedFromContractId: preset.renewFrom || null,
      });
      toast(
        'ok',
        created.serviceContractId
          ? 'Renewal created — its coverage terms are drafted and wait to be activated'
          : 'Project created — budget and schedule of values carried over',
      );
      onCreated(created.id);
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  }

  const customerLocked = !!chosen?.customer;
  const revision = chosen?.quotationRevisions.find((r) => r.id === form.quotationRevisionId) ?? null;
  const approvedRevisions = chosen?.quotationRevisions.filter((r) => r.status === 'APPROVED') ?? [];

  return (
    <Modal
      wide
      title={renewing ? 'Renew service contract' : 'New project'}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button
            className="btn btn-primary"
            onClick={create}
            disabled={busy || !form.costingId || !form.customerId || form.name.length < 2}
          >
            {busy ? 'Creating…' : renewing ? 'Create renewal' : 'Create project'}
          </button>
        </>
      }
    >
      <ErrorBox error={error} />
      <p className="muted del-lede">
        The costing's cost lines become the opening budget, and its scope sections become the
        schedule of values — snapshotted, so later edits to the costing cannot move the ground
        under reported progress.
      </p>

      {renewing && (
        <div className="alert info">
          Renewal of{' '}
          {renewal ? (
            <Link className="mono" to={`/g-ops/service-contracts/${renewal.id}`}>
              {renewal.number}
            </Link>
          ) : (
            'the expiring contract'
          )}
          . Its coverage terms — frequency, response time, exclusions and the equipment covered —
          are copied into a draft contract starting the day after it ends.
        </div>
      )}

      <Field label="Costing" hint="Final costings only. Its scope sections must already total the contract value">
        <select value={form.costingId} onChange={(e) => pickCosting(e.target.value)}>
          <option value="">— choose —</option>
          {costings.map((c) => (
            <option key={c.id} value={c.id}>
              {c.number} — {c.title}
            </option>
          ))}
        </select>
      </Field>

      {chosen && (
        <div className="alert info">
          Contract value: <strong>{formatMoney(chosen.contractValue)}</strong>
          {chosen.status === 'DRAFT' && ' · this costing is still a draft; creating the project finalises it'}
          {revision && (
            <>
              {' '}
              · delivers{' '}
              <Link className="mono" to={`/g-ops/quotations/${revision.quotation.id}`}>
                {revision.quotation.number} R{revision.revision}
              </Link>
            </>
          )}
        </div>
      )}
      {chosen && chosen.jobs.length > 0 && (
        <div className="alert warn">
          This costing already produced{' '}
          {chosen.jobs.map((j, i) => (
            <span key={j.id}>
              {i > 0 && ', '}
              <Link className="mono" to={`/g-ops/projects/${j.id}`}>
                {j.number}
              </Link>
            </span>
          ))}
          . A second project from it would budget the same work twice.
        </div>
      )}

      <div className="grid grid-2">
        <Field label="Project name">
          <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        </Field>
        <Field label="Type">
          <select
            value={form.type}
            disabled={renewing}
            onChange={(e) => setForm({ ...form, type: e.target.value })}
          >
            <option value="PROJECT">Project</option>
            <option value="SERVICE_CONTRACT">Service contract</option>
          </select>
        </Field>
        <Field label="Customer" hint={customerLocked ? 'Taken from the costing' : undefined}>
          {customerLocked && chosen?.customer ? (
            <div className="del-locked">
              <Link to={`/g-ops/customers/${chosen.customer.id}`}>{chosen.customer.name}</Link>
            </div>
          ) : (
            <select
              value={form.customerId}
              onChange={(e) => setForm({ ...form, customerId: e.target.value, siteId: '' })}
            >
              <option value="">— choose —</option>
              {customers.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          )}
        </Field>
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
        {approvedRevisions.length > 1 && (
          <Field label="Quotation" hint="The approved revision this project delivers">
            <select
              value={form.quotationRevisionId}
              onChange={(e) => setForm({ ...form, quotationRevisionId: e.target.value })}
            >
              <option value="">— none —</option>
              {approvedRevisions.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.quotation.number} R{r.revision}
                </option>
              ))}
            </select>
          </Field>
        )}
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
        <Field label="Start date" hint="Scope sections are scheduled back to back from here">
          <input
            type="date"
            value={form.startDate}
            onChange={(e) => setForm({ ...form, startDate: e.target.value })}
          />
        </Field>
        <Field label="Customer P.O. number">
          <input
            value={form.customerPoNumber}
            onChange={(e) => setForm({ ...form, customerPoNumber: e.target.value })}
          />
        </Field>
        <Field label="Customer P.O. date">
          <input
            type="date"
            value={form.customerPoDate}
            onChange={(e) => setForm({ ...form, customerPoDate: e.target.value })}
          />
        </Field>
      </div>
    </Modal>
  );
}
