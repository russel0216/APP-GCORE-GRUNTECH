import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { DataList, type Column } from '../../components/DataList';
import { ErrorBox, Field, Modal, formatDate, formatMoney, useToast } from '../../components/ui';
import { Meter as ProgressBar } from '../../components/charts';

export const JOB_STATUSES = [
  { value: 'PLANNING', label: 'Planning' },
  { value: 'IN_PROGRESS', label: 'In progress' },
  { value: 'ON_HOLD', label: 'On hold' },
  { value: 'COMPLETED', label: 'Completed' },
  { value: 'TURNED_OVER', label: 'Turned over' },
  { value: 'CANCELLED', label: 'Cancelled' },
];

export function jobStatusTone(s: string) {
  if (s === 'COMPLETED' || s === 'TURNED_OVER') return 'ok';
  if (s === 'CANCELLED') return 'danger';
  if (s === 'ON_HOLD') return 'warn';
  if (s === 'IN_PROGRESS') return 'info';
  return '';
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

export function Projects() {
  const { can } = useAuth();
  const navigate = useNavigate();
  const [creating, setCreating] = useState(false);
  const [reload, setReload] = useState(0);

  const columns: Column<JobRow>[] = [
    { key: 'number', label: 'Number', sortKey: 'number', width: '160px', render: (j) => <span className="mono">{j.number}</span> },
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
      width: '130px',
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
      render: (j) => (
        <span className={`badge ${jobStatusTone(j.status)}`}>
          {JOB_STATUSES.find((s) => s.value === j.status)?.label ?? j.status}
        </span>
      ),
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

      {creating && (
        <NewJobModal
          onClose={() => setCreating(false)}
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

function NewJobModal({ onClose, onCreated }: { onClose: () => void; onCreated: (id: string) => void }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [costings, setCostings] = useState<
    { id: string; number: string; title: string; contractValue: number }[]
  >([]);
  const [customers, setCustomers] = useState<{ id: string; name: string }[]>([]);
  const [sites, setSites] = useState<{ id: string; name: string }[]>([]);
  const [people, setPeople] = useState<{ id: string; name: string }[]>([]);
  const [chosen, setChosen] = useState<{ contractValue: number } | null>(null);

  const [form, setForm] = useState({
    costingId: '',
    name: '',
    type: 'PROJECT',
    customerId: '',
    siteId: '',
    projectManagerId: '',
    customerPoNumber: '',
    customerPoDate: '',
    startDate: new Date().toISOString().slice(0, 10),
  });

  useEffect(() => {
    api.get<typeof costings>('/costings/lookup').then(setCostings).catch(() => {});
    api.get<typeof customers>('/customers/lookup').then(setCustomers).catch(() => {});
    api
      .get<{ rows: { id: string; name: string }[] }>('/users?pageSize=200')
      .then((r) => setPeople(r.rows))
      .catch(() => {});
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

  /** Choosing a costing pre-fills the name, customer and contract value. */
  async function pickCosting(costingId: string) {
    setForm((f) => ({ ...f, costingId }));
    if (!costingId) {
      setChosen(null);
      return;
    }
    try {
      const c = await api.get<{
        title: string;
        contractValue: number;
        customer: { id: string } | null;
        scopeSections: unknown[];
        scopeTotal: number;
      }>(`/costings/${costingId}`);
      setChosen({ contractValue: c.contractValue });
      setForm((f) => ({
        ...f,
        name: f.name || c.title,
        customerId: f.customerId || c.customer?.id || '',
      }));
    } catch {
      /* the create call will report anything wrong */
    }
  }

  async function create() {
    setBusy(true);
    setError(null);
    try {
      const created = await api.post<{ id: string }>('/jobs', {
        costingId: form.costingId,
        name: form.name,
        type: form.type,
        customerId: form.customerId,
        siteId: form.siteId || null,
        projectManagerId: form.projectManagerId || null,
        customerPoNumber: form.customerPoNumber || null,
        customerPoDate: form.customerPoDate || null,
        startDate: form.startDate || null,
      });
      toast('ok', 'Project created — budget and schedule of values carried over');
      onCreated(created.id);
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  }

  return (
    <Modal
      wide
      title="New project"
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
            {busy ? 'Creating…' : 'Create project'}
          </button>
        </>
      }
    >
      <ErrorBox error={error} />
      <p className="muted" style={{ marginTop: 0 }}>
        The costing's cost lines become the opening budget, and its scope sections become the
        schedule of values — snapshotted, so later edits to the costing cannot move the ground
        under reported progress.
      </p>

      <Field label="Costing" hint="Its scope sections must already total the contract value">
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
        </div>
      )}

      <div className="grid grid-2">
        <Field label="Project name">
          <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        </Field>
        <Field label="Type">
          <select value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })}>
            <option value="PROJECT">Project</option>
            <option value="SERVICE_CONTRACT">Service contract</option>
          </select>
        </Field>
        <Field label="Customer">
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
