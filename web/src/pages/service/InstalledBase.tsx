import { useCallback, useEffect, useId, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, qs } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { DataList, type Column } from '../../components/DataList';
import { RecordHeader } from '../../components/RecordHeader';
import { CustomerPicker, type CustomerRef } from '../../components/CustomerPicker';
import {
  ErrorBox,
  Field,
  Loading,
  Modal,
  ModalFoot,
  StatusBadge,
  formatDate,
  useToast,
  type Tone,
} from '../../components/ui';
import { KIND_LABEL } from './Reports';
import { VisitBadge } from './Schedule';
import { BasisBadge } from './JobOrders';
import { Stat } from '../../components/charts';
import { useTeams } from '../finance/Receivables';

/**
 * The installed base — what Gruntech put in, where it stands, and when its
 * warranty runs out.
 *
 * This register is what turns a finished project into a renewal pipeline
 * (model §4.5). Without it nobody can answer "what did we install at that
 * hospital, and when does the free repair stop".
 */

/** Warranty STATE, not a document status — passed to StatusBadge as its own map. */
export const WARRANTY_TONE: Record<string, Tone> = {
  ACTIVE: 'ok',
  EXPIRING: 'warn',
  EXPIRED: 'danger',
  NONE: '',
};

function WarrantyBadge({ state }: { state: string }) {
  return <StatusBadge status={state} extra={WARRANTY_TONE} label={WARRANTY_LABEL[state]} />;
}

export const WARRANTY_LABEL: Record<string, string> = {
  ACTIVE: 'in warranty',
  EXPIRING: 'expiring',
  EXPIRED: 'out of warranty',
  NONE: 'not recorded',
};

export interface Asset {
  id: string;
  code: string;
  status: string;
  name: string;
  manufacturer: string | null;
  model: string | null;
  serialNo: string | null;
  capacity: string | null;
  location: string | null;
  address: string | null;
  installedAt: string | null;
  commissionedAt: string | null;
  warrantyEndsAt: string | null;
  warranty: string;
  warrantyDaysRemaining: number | null;
  notes: string | null;
  customer: { id: string; code: string; name: string; industry?: { id: string; code: string; name: string } | null };
  site: { id: string; name: string; city: string | null } | null;
  job: { id: string; number: string; name: string } | null;
  item: { id: string; code: string; name: string } | null;
}

/** The cards over the register: the list's own query (2026-10-20). */
interface AssetSummary {
  inWarranty: number;
  expiring: number;
  uncovered: number;
  warningDays: number;
}

export function InstalledBase() {
  const { can } = useAuth();
  const navigate = useNavigate();
  const [creating, setCreating] = useState(false);
  const [reload, setReload] = useState(0);

  const teams = useTeams();

  // The owner's columns (2026-10-20): Equipment / Model, Serial number,
  // Customer & Location, Installed date, Industry team, Warranty status.
  const columns: Column<Asset>[] = [
    {
      key: 'code',
      label: 'Code',
      sortKey: 'code',
      width: '140px',
      optional: true,
      render: (r) => <span className="mono">{r.code}</span>,
    },
    {
      key: 'name',
      label: 'Equipment / model',
      sortKey: 'name',
      render: (r) => (
        <div>
          <div>{r.name}</div>
          <div className="faint">{[r.manufacturer, r.model].filter(Boolean).join(' ') || '—'}</div>
        </div>
      ),
    },
    {
      key: 'serialNo',
      label: 'Serial number',
      width: '150px',
      render: (r) => (r.serialNo ? <span className="mono">{r.serialNo}</span> : <span className="faint">—</span>),
    },
    {
      key: 'customer',
      label: 'Customer & location',
      render: (r) => (
        <div>
          <div>{r.customer.name}</div>
          <div className="faint">
            {r.site?.name ?? r.address ?? '—'}
            {r.location && ` · ${r.location}`}
          </div>
        </div>
      ),
    },
    {
      key: 'job',
      label: 'Installed by',
      optional: true,
      render: (r) =>
        r.job ? (
          <span className="mono">{r.job.number}</span>
        ) : (
          <span className="faint">not recorded</span>
        ),
    },
    {
      key: 'installedAt',
      label: 'Installed date',
      sortKey: 'installedAt',
      render: (r) => formatDate(r.installedAt),
    },
    {
      key: 'team',
      label: 'Industry team',
      width: '110px',
      render: (r) =>
        r.customer.industry ? (
          <span title={r.customer.industry.name}>{r.customer.industry.code}</span>
        ) : (
          <span className="faint">Open</span>
        ),
    },
    {
      key: 'warranty',
      label: 'Warranty status',
      sortKey: 'warrantyEndsAt',
      render: (r) => (
        <div>
          <WarrantyBadge state={r.warranty} />
          {r.warrantyEndsAt && (
            <div className="faint">
              {r.warranty === 'EXPIRED'
                ? `ended ${formatDate(r.warrantyEndsAt)}`
                : `${r.warrantyDaysRemaining} days left`}
            </div>
          )}
        </div>
      ),
    },
    {
      key: 'status',
      label: 'Status',
      render: (r) => <StatusBadge status={r.status} extra={{ INACTIVE: '', DECOMMISSIONED: '' }} />,
      optional: true,
    },
  ];

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Installation Base</h1>
        </div>
      </div>

      <DataList<Asset>
        listKey="installed-base"
        endpoint="/installed-assets"
        columns={columns}
        rowKey={(r) => r.id}
        rowLabel={(r) => `Select ${r.code}`}
        // Tick boxes for Print selected and Export selected (`?ids=`, the rows' ids).
        selectable
        reloadToken={reload}
        searchPlaceholder="Search code, name, serial, model, customer…"
        emptyTitle="Nothing registered yet"
        emptyHint="A project registers what it installed when it is turned over, from its workspace. Or add a machine here."
        onRowClick={(r) => navigate(`/g-ops/installed-base/${r.id}`)}
        summary={(raw, total) => {
          const sum = raw as unknown as AssetSummary;
          return (
            <>
              <Stat label="Installed equipment" value={total} hint={`${total === 1 ? 'unit' : 'units'} listed`} />
              <Stat label="In warranty" value={sum.inWarranty} />
              <Stat
                label="Warranty expiring"
                value={sum.expiring}
                hint={`within ${sum.warningDays} days`}
                tone={sum.expiring > 0 ? 'var(--warn)' : undefined}
              />
              <Stat label="No active contract" value={sum.uncovered} tone={sum.uncovered > 0 ? 'var(--warn)' : undefined} />
            </>
          );
        }}
        filters={[
          {
            key: 'teamId',
            label: 'Industry team',
            options: [
              ...teams.map((t) => ({ value: t.id, label: `${t.code} — ${t.name}` })),
              { value: 'none', label: 'Open (customer has no team yet)' },
            ],
          },
          {
            key: 'warranty',
            label: 'Warranty',
            options: [
              { value: 'ACTIVE', label: 'In warranty' },
              { value: 'EXPIRING', label: 'Expiring soon' },
              { value: 'EXPIRED', label: 'Out of warranty' },
            ],
          },
          {
            key: 'uncovered',
            label: 'Cover',
            options: [{ value: 'true', label: 'No active contract' }],
          },
          // The project that installed it — a project's overview links here
          // (2026-10-15, when the project's Service tab went).
          {
            key: 'jobId',
            label: 'Project',
            type: 'lookup' as const,
            placeholder: 'Type a project number or name…',
            search: async (term: string) =>
              (await api.get<{ id: string; number: string; name: string }[]>(`/jobs/lookup${qs({ q: term, includeClosed: 'true' })}`)).map(
                (j) => ({ value: j.id, label: `${j.number} — ${j.name}` }),
              ),
            describe: async (id: string) => {
              const j = await api.get<{ number: string; name: string }>(`/jobs/${id}`);
              return `${j.number} — ${j.name}`;
            },
          },
          {
            key: 'status',
            label: 'Status',
            options: [
              { value: 'ACTIVE', label: 'Active' },
              { value: 'INACTIVE', label: 'Inactive' },
              { value: 'DECOMMISSIONED', label: 'Decommissioned' },
            ],
          },
        ]}
        // The paper matches the screen: DataList sends the list's own query.
        // Its "Export CSV" is the Excel-ready twin.
        printPath="/api/installed-assets/pdf"
        actions={
          <>
            {can('gops.installed_base.create') && (
              <button className="btn btn-primary btn-sm" onClick={() => setCreating(true)}>
                + New equipment
              </button>
            )}
          </>
        }
      />

      {creating && (
        <AssetModal
          onClose={() => setCreating(false)}
          onSaved={(id) => {
            setCreating(false);
            setReload((r) => r + 1);
            navigate(`/g-ops/installed-base/${id}`);
          }}
        />
      )}
    </div>
  );
}

function AssetModal({
  asset,
  onClose,
  onSaved,
}: {
  asset?: Asset;
  onClose: () => void;
  onSaved: (id: string) => void;
}) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  // The one customer picker: predicted as it is typed (name or code), and
  // "add as a new customer" files the company through the ordinary customer
  // create, so it gets its code and its audit row (the sub-industry is typed
  // in later, on the customer).
  const [customer, setCustomer] = useState<CustomerRef | null>(
    asset ? { id: asset.customer.id, name: asset.customer.name } : null,
  );
  const customerInputId = useId();
  const [jobs, setJobs] = useState<{ id: string; number: string; name: string }[]>([]);
  const [types, setTypes] = useState<string[]>([]);
  const [settings, setSettings] = useState<{ defaultWarrantyMonths: number } | null>(null);

  const [form, setForm] = useState({
    jobId: asset?.job?.id ?? '',
    name: asset?.name ?? '',
    manufacturer: asset?.manufacturer ?? '',
    model: asset?.model ?? '',
    serialNo: asset?.serialNo ?? '',
    capacity: asset?.capacity ?? '',
    location: asset?.location ?? '',
    address: asset?.address ?? '',
    installedAt: asset?.installedAt?.slice(0, 10) ?? '',
    warrantyEndsAt: asset?.warrantyEndsAt?.slice(0, 10) ?? '',
    status: asset?.status ?? 'ACTIVE',
    notes: asset?.notes ?? '',
  });

  useEffect(() => {
    api.get<typeof jobs>('/jobs/lookup?includeClosed=true').then(setJobs).catch(() => {});
    api.get<string[]>('/installed-assets/types').then(setTypes).catch(() => {});
    api.get<{ defaultWarrantyMonths: number }>('/aftermarket/settings').then(setSettings).catch(() => {});
  }, []);

  // Show what the warranty will be set to when nobody types one.
  const derivedWarranty = (() => {
    if (form.warrantyEndsAt || !form.installedAt || !settings) return null;
    const d = new Date(`${form.installedAt}T00:00:00Z`);
    const day = d.getUTCDate();
    d.setUTCDate(1);
    d.setUTCMonth(d.getUTCMonth() + settings.defaultWarrantyMonths);
    const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
    d.setUTCDate(Math.min(day, last));
    return d.toISOString().slice(0, 10);
  })();

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const payload = {
        customerId: customer?.id ?? '',
        jobId: form.jobId || null,
        name: form.name,
        manufacturer: form.manufacturer || null,
        model: form.model || null,
        serialNo: form.serialNo || null,
        capacity: form.capacity || null,
        location: form.location || null,
        address: form.address || null,
        installedAt: form.installedAt || null,
        warrantyEndsAt: form.warrantyEndsAt || null,
        status: form.status,
        notes: form.notes || null,
      };
      const saved = asset
        ? await api.patch<{ id: string }>(`/installed-assets/${asset.id}`, payload)
        : await api.post<{ id: string }>('/installed-assets', payload);
      toast('ok', asset ? 'Saved' : 'Registered');
      onSaved(saved.id);
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  }

  return (
    <Modal
      title={asset ? `Modify equipment ${asset.code}` : 'New equipment'}
      onClose={onClose}
      wide
      footer={
        <ModalFoot onCancel={onClose} busy={busy}>
          <button
            className="btn btn-primary"
            onClick={save}
            disabled={
              busy ||
              !customer ||
              form.name.trim().length < 2
            }
          >
            {busy ? 'Saving…' : 'Save'}
          </button>
        </ModalFoot>
      }
    >
      <ErrorBox error={error} />

      <div className="grid grid-2">
        <Field label="Customer" hint="Type to find one used before" htmlFor={customerInputId}>
          <CustomerPicker
            inputId={customerInputId}
            value={customer}
            onChange={setCustomer}
            onError={setError}
            allowCreate={!asset}
          />
        </Field>
        <Field label="Address" hint="Where the machine is">
          <input
            value={form.address}
            onChange={(e) => setForm({ ...form, address: e.target.value })}
            placeholder="e.g. 12F PNB Makati Center, Ayala Avenue, Makati City"
          />
        </Field>
      </div>

      <Field label="Equipment type" hint="Pick a common one, or type a new one — it is remembered">
        <input
          value={form.name}
          list="ib-equipment-types"
          onChange={(e) => setForm({ ...form, name: e.target.value.toUpperCase() })}
          placeholder="COMPRESSOR, DRYER, FIRE PUMP…"
        />
        <datalist id="ib-equipment-types">
          {types.map((t) => (
            <option key={t} value={t} />
          ))}
        </datalist>
      </Field>

      <div className="grid grid-3">
        <Field label="Manufacturer">
          <input
            value={form.manufacturer}
            onChange={(e) => setForm({ ...form, manufacturer: e.target.value })}
          />
        </Field>
        <Field label="Model">
          <input value={form.model} onChange={(e) => setForm({ ...form, model: e.target.value })} />
        </Field>
        <Field label="Serial number" hint="Registering the same serial twice splits its history">
          <input
            value={form.serialNo}
            onChange={(e) => setForm({ ...form, serialNo: e.target.value })}
          />
        </Field>
      </div>

      <div className="grid grid-2">
        <Field label="Specification" hint="Supply voltage, power, flow, pressure, application…">
          <textarea
            rows={3}
            value={form.capacity}
            onChange={(e) => setForm({ ...form, capacity: e.target.value })}
            placeholder={'e.g. 460 V · 75 kW · 40 LPM at 93% purity · medical oxygen'}
          />
        </Field>
        <Field label="Location">
          <input
            value={form.location}
            onChange={(e) => setForm({ ...form, location: e.target.value })}
            placeholder="e.g. Plant room, 2nd floor"
          />
        </Field>
      </div>

      <div className="grid grid-3">
        <Field label="Installed on">
          <input
            type="date"
            value={form.installedAt}
            onChange={(e) => setForm({ ...form, installedAt: e.target.value })}
          />
        </Field>
        <Field
          label="Warranty ends"
          hint={derivedWarranty ? `Leave empty and it becomes ${formatDate(derivedWarranty)}` : undefined}
        >
          <input
            type="date"
            value={form.warrantyEndsAt}
            onChange={(e) => setForm({ ...form, warrantyEndsAt: e.target.value })}
          />
        </Field>
        <Field label="Installed by project">
          <select value={form.jobId} onChange={(e) => setForm({ ...form, jobId: e.target.value })}>
            <option value="">— not recorded —</option>
            {jobs.map((j) => (
              <option key={j.id} value={j.id}>
                {j.number} — {j.name}
              </option>
            ))}
          </select>
        </Field>
      </div>

      {asset && (
        <Field label="Status">
          <select value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value })}>
            <option value="ACTIVE">Active — in service</option>
            <option value="INACTIVE">Inactive — installed but not running</option>
            <option value="DECOMMISSIONED">Decommissioned — removed or replaced</option>
          </select>
        </Field>
      )}

      <Field label="Notes">
        <input value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
      </Field>
    </Modal>
  );
}

// ── One machine, and everything that ever happened to it ─────────────────────

interface AssetDetail extends Asset {
  /** Edit All, or Edit Own on a machine the viewer registered (2026-10-18). */
  canEdit?: boolean;
  contracts: {
    id: string;
    number: string;
    status: string;
    startsAt: string;
    endsAt: string;
    job: { id: string; number: string; name: string };
  }[];
  reports: {
    id: string;
    number: string;
    kind: string;
    status: string;
    performedAt: string;
    findings: string | null;
    performedBy: { id: string; name: string };
  }[];
  upcomingVisits: { id: string; number: string; dueDate: string; kind: string; status: string }[];
  jobOrders: {
    id: string;
    number: string;
    kind: string;
    status: string;
    title: string;
    requestedFor: string;
    chargeBasis: string;
  }[];
}

export function AssetDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { can, canView } = useAuth();
  const [row, setRow] = useState<AssetDetail | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [editing, setEditing] = useState(false);

  const load = useCallback(async () => {
    try {
      setRow(await api.get<AssetDetail>(`/installed-assets/${id}`));
    } catch (err) {
      setError(err);
    }
  }, [id]);

  useEffect(() => {
    load();
  }, [load]);

  if (error) return <ErrorBox error={error} />;
  if (!row) return <Loading />;

  const covered = row.contracts.some((c) => c.status === 'ACTIVE');

  return (
    <div>
      <RecordHeader
        type="Equipment"
        code={row.code}
        title={row.name}
        status={row.warranty}
        statusExtra={WARRANTY_TONE}
        statusLabel={WARRANTY_LABEL[row.warranty]}
        meta={
          <>
            {can('gops.customers.view_all') ? (
              <Link to={`/g-ops/customers/${row.customer.id}`}>{row.customer.name}</Link>
            ) : (
              row.customer.name
            )}
            {(row.site?.name ?? row.address) && ` · ${row.site?.name ?? row.address}`}
            {row.serialNo && (
              <>
                {' · serial '}
                <span className="mono">{row.serialNo}</span>
              </>
            )}
          </>
        }
        modify={row.canEdit ? () => setEditing(true) : undefined}
      />

      {row.warranty === 'EXPIRING' && !covered && (
        <div className="alert warn">
          Warranty ends in {row.warrantyDaysRemaining} days and nothing covers this machine
          afterwards. From that date the customer pays for every call-out — which is the
          conversation to have now, not then.
        </div>
      )}
      {row.warranty === 'EXPIRED' && !covered && (
        <div className="alert warn">
          Out of warranty since {formatDate(row.warrantyEndsAt)} and not under contract. Every
          visit to this machine is billable.
        </div>
      )}

      <div className="grid grid-2">
        <div className="card">
          <h3 className="card-title">The machine</h3>
          <dl className="kv">
            <dt>Make and model</dt>
            <dd>{[row.manufacturer, row.model].filter(Boolean).join(' ') || '—'}</dd>
            <dt>Specification</dt>
            <dd className="ib-spec">{row.capacity ?? '—'}</dd>
            <dt>Address</dt>
            <dd>{row.address ?? row.site?.name ?? '—'}</dd>
            <dt>Location</dt>
            <dd>{row.location ?? '—'}</dd>
            <dt>Installed</dt>
            <dd>{formatDate(row.installedAt)}</dd>
            <dt>Commissioned</dt>
            <dd>{row.commissionedAt ? formatDate(row.commissionedAt) : <span className="faint">not yet</span>}</dd>
            <dt>Warranty ends</dt>
            <dd>{row.warrantyEndsAt ? formatDate(row.warrantyEndsAt) : <span className="faint">not recorded</span>}</dd>
            <dt>Installed by</dt>
            <dd>
              {row.job ? (
                <Link to={`/g-ops/projects/${row.job.id}`} className="mono">
                  {row.job.number}
                </Link>
              ) : (
                <span className="faint">not recorded</span>
              )}
            </dd>
            {row.item && (
              <>
                <dt>Catalogue item</dt>
                <dd>
                  {can('gchain.items.view_all') ? (
                    <Link to={`/g-chain/items/${row.item.id}`}>{row.item.name}</Link>
                  ) : (
                    row.item.name
                  )}{' '}
                  <span className="faint mono">{row.item.code}</span>
                </dd>
              </>
            )}
            {row.notes && (
              <>
                <dt>Notes</dt>
                <dd>{row.notes}</dd>
              </>
            )}
          </dl>
        </div>

        <div>
          <div className="card">
            <h3 className="card-title">Cover</h3>
            {row.contracts.length === 0 ? (
              <p className="muted">No service contract has ever covered this machine.</p>
            ) : (
              <div className="stack">
                {row.contracts.map((c) => (
                  <div key={c.id} className="svc-line">
                    <span>
                      <Link to={`/g-ops/service-contracts/${c.id}`} className="mono">
                        {c.number}
                      </Link>
                      <div className="faint">
                        {formatDate(c.startsAt)} → {formatDate(c.endsAt)}
                      </div>
                    </span>
                    <StatusBadge status={c.status} extra={{ RENEWED: 'info' }} />
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="card">
            <div className="panel-head">
              <h3 className="card-title">Next visits</h3>
              {canView('gops', 'visits') && (
                <Link to={`/g-ops/visits?mode=list&assetId=${row.id}`}>All visits</Link>
              )}
            </div>
            {row.upcomingVisits.length === 0 ? (
              <p className="muted">Nothing booked for this machine.</p>
            ) : (
              <div className="stack">
                {row.upcomingVisits.map((v) => (
                  <div key={v.id} className="svc-line">
                    <span>
                      <Link to={`/g-ops/visits?visit=${v.id}`} className="mono">
                        {v.number}
                      </Link>{' '}
                      <span className="faint">{KIND_LABEL[v.kind] ?? v.kind}</span>
                    </span>
                    <span>
                      <span className="faint">{formatDate(v.dueDate)}</span>{' '}
                      {v.status === 'MISSED' && <VisitBadge visit={{ status: v.status, overdue: false }} />}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      {(canView('gops', 'service_job_orders') || can('gops.service_job_orders.create')) && (
        <div className="card">
          <div className="card-head">
            <h3 className="card-title">Service JOs</h3>
            {can('gops.service_job_orders.create') && row.status !== 'DECOMMISSIONED' && (
              <Link className="btn btn-primary btn-sm" to={`/g-ops/service-job-orders?new=1&customerId=${row.customer.id}&assetId=${row.id}`}>
                + New service JO
              </Link>
            )}
          </div>
          {row.jobOrders.length === 0 ? (
            <p className="muted">No service requested for this machine yet.</p>
          ) : (
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    <th>Order</th>
                    <th>Job</th>
                    <th>Wanted</th>
                    <th>Covered by</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {row.jobOrders.map((j) => (
                    <tr key={j.id}>
                      <td>
                        <Link to={`/g-ops/service-job-orders/${j.id}`} className="mono">
                          {j.number}
                        </Link>
                      </td>
                      <td>
                        {j.title}
                        <div className="faint">{KIND_LABEL[j.kind] ?? j.kind}</div>
                      </td>
                      <td>{formatDate(j.requestedFor)}</td>
                      <td>
                        <BasisBadge basis={j.chargeBasis} />
                      </td>
                      <td>
                        <StatusBadge status={j.status} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      <div className="card">
        <h3 className="card-title">Service history</h3>
        {row.reports.length === 0 ? (
          <p className="muted">
            Nothing has been reported against this machine yet.
          </p>
        ) : (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Report</th>
                  <th>Kind</th>
                  <th>Performed</th>
                  <th>By</th>
                  <th>Findings</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {row.reports.map((r) => (
                  <tr key={r.id}>
                    <td>
                      <Link to={`/g-ops/service-reports/${r.id}`} className="mono">
                        {r.number}
                      </Link>
                    </td>
                    <td className="faint">{KIND_LABEL[r.kind] ?? r.kind}</td>
                    <td>{formatDate(r.performedAt)}</td>
                    <td className="faint">{r.performedBy.name}</td>
                    <td className="faint">{r.findings ?? '—'}</td>
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

      {editing && (
        <AssetModal
          asset={row}
          onClose={() => setEditing(false)}
          onSaved={() => {
            setEditing(false);
            load();
          }}
        />
      )}
    </div>
  );
}
