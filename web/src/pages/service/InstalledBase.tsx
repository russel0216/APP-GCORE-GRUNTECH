import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { DataList, type Column } from '../../components/DataList';
import {
  ErrorBox,
  Field,
  Loading,
  Modal,
  formatDate,
  useToast,
} from '../../components/ui';

/**
 * The installed base — what Gruntech put in, where it stands, and when its
 * warranty runs out.
 *
 * This register is what turns a finished project into a renewal pipeline
 * (model §4.5). Without it nobody can answer "what did we install at that
 * hospital, and when does the free repair stop".
 */

export const WARRANTY_TONE: Record<string, string> = {
  ACTIVE: 'ok',
  EXPIRING: 'warn',
  EXPIRED: 'danger',
  NONE: '',
};

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
  installedAt: string | null;
  commissionedAt: string | null;
  warrantyEndsAt: string | null;
  warranty: string;
  warrantyDaysRemaining: number | null;
  notes: string | null;
  customer: { id: string; code: string; name: string };
  site: { id: string; name: string; city: string | null } | null;
  job: { id: string; number: string; name: string } | null;
  item: { id: string; code: string; name: string } | null;
}

export function InstalledBase() {
  const { can } = useAuth();
  const navigate = useNavigate();
  const [creating, setCreating] = useState(false);
  const [reload, setReload] = useState(0);

  const columns: Column<Asset>[] = [
    {
      key: 'code',
      label: 'Code',
      sortKey: 'code',
      width: '140px',
      render: (r) => <span className="mono">{r.code}</span>,
    },
    {
      key: 'name',
      label: 'Equipment',
      sortKey: 'name',
      render: (r) => (
        <div>
          <div>{r.name}</div>
          <div className="faint">
            {[r.manufacturer, r.model].filter(Boolean).join(' ') || '—'}
            {r.serialNo && <span className="mono"> · {r.serialNo}</span>}
          </div>
        </div>
      ),
    },
    {
      key: 'customer',
      label: 'Where',
      render: (r) => (
        <div>
          <div>{r.customer.name}</div>
          <div className="faint">
            {r.site?.name ?? '—'}
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
      label: 'Installed',
      sortKey: 'installedAt',
      render: (r) => formatDate(r.installedAt),
      optional: true,
    },
    {
      key: 'warranty',
      label: 'Warranty',
      sortKey: 'warrantyEndsAt',
      render: (r) => (
        <div>
          <span className={`badge ${WARRANTY_TONE[r.warranty] ?? ''}`}>
            {WARRANTY_LABEL[r.warranty]}
          </span>
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
      render: (r) => (
        <span className={`badge ${r.status === 'ACTIVE' ? 'ok' : ''}`}>
          {r.status.toLowerCase()}
        </span>
      ),
      optional: true,
    },
  ];

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Installed Base</h1>
          <p>
            Every machine Gruntech put in, where it is, and when the free repair stops. Equipment
            whose warranty is lapsing with no contract behind it is the renewal pipeline — the
            customer is about to start paying for what they currently get free.
          </p>
        </div>
      </div>

      <DataList<Asset>
        listKey="installed-base"
        endpoint="/installed-assets"
        columns={columns}
        rowKey={(r) => r.id}
        reloadToken={reload}
        searchPlaceholder="Search code, name, serial, model, customer…"
        emptyTitle="Nothing registered yet"
        emptyHint="Register what a project installed from its workspace, or add a machine here."
        onRowClick={(r) => navigate(`/g-ops/installed-base/${r.id}`)}
        filters={[
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
        actions={
          can('gops.installed_base.create') ? (
            <button className="btn btn-primary btn-sm" onClick={() => setCreating(true)}>
              + Register equipment
            </button>
          ) : null
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
  const [customers, setCustomers] = useState<{ id: string; name: string }[]>([]);
  const [sites, setSites] = useState<{ id: string; name: string }[]>([]);
  const [jobs, setJobs] = useState<{ id: string; number: string; name: string }[]>([]);
  const [settings, setSettings] = useState<{ defaultWarrantyMonths: number } | null>(null);

  const [form, setForm] = useState({
    customerId: asset?.customer.id ?? '',
    siteId: asset?.site?.id ?? '',
    jobId: asset?.job?.id ?? '',
    name: asset?.name ?? '',
    manufacturer: asset?.manufacturer ?? '',
    model: asset?.model ?? '',
    serialNo: asset?.serialNo ?? '',
    capacity: asset?.capacity ?? '',
    location: asset?.location ?? '',
    installedAt: asset?.installedAt?.slice(0, 10) ?? '',
    warrantyEndsAt: asset?.warrantyEndsAt?.slice(0, 10) ?? '',
    status: asset?.status ?? 'ACTIVE',
    notes: asset?.notes ?? '',
  });

  useEffect(() => {
    api.get<{ rows: { id: string; name: string }[] }>('/customers?pageSize=200').then((d) => setCustomers(d.rows)).catch(() => {});
    api.get<typeof jobs>('/jobs/lookup').then(setJobs).catch(() => {});
    api.get<{ defaultWarrantyMonths: number }>('/aftermarket/settings').then(setSettings).catch(() => {});
  }, []);

  useEffect(() => {
    if (!form.customerId) {
      setSites([]);
      return;
    }
    api
      .get<{ sites: { id: string; name: string }[] }>(`/customers/${form.customerId}`)
      .then((c) => setSites(c.sites ?? []))
      .catch(() => setSites([]));
  }, [form.customerId]);

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
        customerId: form.customerId,
        siteId: form.siteId || null,
        jobId: form.jobId || null,
        name: form.name,
        manufacturer: form.manufacturer || null,
        model: form.model || null,
        serialNo: form.serialNo || null,
        capacity: form.capacity || null,
        location: form.location || null,
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
      title={asset ? `Edit ${asset.code}` : 'Register equipment'}
      onClose={onClose}
      wide
      footer={
        <>
          <button className="btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button
            className="btn btn-primary"
            onClick={save}
            disabled={busy || !form.customerId || form.name.trim().length < 2}
          >
            {busy ? 'Saving…' : asset ? 'Save' : 'Register'}
          </button>
        </>
      }
    >
      <ErrorBox error={error} />

      <div className="grid grid-2">
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
      </div>

      <Field label="What is it?">
        <input
          value={form.name}
          onChange={(e) => setForm({ ...form, name: e.target.value })}
          placeholder="e.g. PSA Oxygen Generator"
        />
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
        <Field label="Capacity / rating">
          <input
            value={form.capacity}
            onChange={(e) => setForm({ ...form, capacity: e.target.value })}
            placeholder="e.g. 40 LPM at 93% purity"
          />
        </Field>
        <Field label="Where on site">
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
  upcomingVisits: { id: string; number: string; dueDate: string; kind: string }[];
}

export function AssetDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { can } = useAuth();
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
      <div className="breadcrumb">
        <button className="btn btn-ghost btn-sm" onClick={() => navigate('/g-ops/installed-base')}>
          ← Installed base
        </button>
      </div>

      <div className="page-head">
        <div>
          <h1>
            {row.name}{' '}
            <span className={`badge ${WARRANTY_TONE[row.warranty] ?? ''}`}>
              {WARRANTY_LABEL[row.warranty]}
            </span>
          </h1>
          <p>
            <span className="mono">{row.code}</span> · {row.customer.name}
            {row.site && ` · ${row.site.name}`}
            {row.serialNo && (
              <>
                {' · serial '}
                <span className="mono">{row.serialNo}</span>
              </>
            )}
          </p>
        </div>
        {can('gops.installed_base.edit_all') && (
          <button className="btn btn-sm" onClick={() => setEditing(true)}>
            Edit
          </button>
        )}
      </div>

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
            <dt>Capacity</dt>
            <dd>{row.capacity ?? '—'}</dd>
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
              <p className="muted" style={{ marginBottom: 0 }}>
                No service contract has ever covered this machine.
              </p>
            ) : (
              <div className="stack">
                {row.contracts.map((c) => (
                  <div key={c.id} className="row" style={{ justifyContent: 'space-between' }}>
                    <span>
                      <Link to={`/g-ops/service-contracts/${c.id}`} className="mono">
                        {c.number}
                      </Link>
                      <div className="faint">
                        {formatDate(c.startsAt)} → {formatDate(c.endsAt)}
                      </div>
                    </span>
                    <span className={`badge ${c.status === 'ACTIVE' ? 'ok' : ''}`}>
                      {c.status.toLowerCase()}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>

          {row.upcomingVisits.length > 0 && (
            <div className="card">
              <h3 className="card-title">Next visits</h3>
              <div className="stack">
                {row.upcomingVisits.map((v) => (
                  <div key={v.id} className="row" style={{ justifyContent: 'space-between' }}>
                    <span className="mono">{v.number}</span>
                    <span className="faint">{formatDate(v.dueDate)}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>

      <div className="card">
        <h3 className="card-title">Service history</h3>
        {row.reports.length === 0 ? (
          <p className="muted" style={{ marginBottom: 0 }}>
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
                    <td className="faint">{r.kind.toLowerCase().replace(/_/g, ' ')}</td>
                    <td>{formatDate(r.performedAt)}</td>
                    <td className="faint">{r.performedBy.name}</td>
                    <td className="faint">{r.findings ?? '—'}</td>
                    <td>
                      <span className={`badge ${r.status === 'APPROVED' ? 'ok' : r.status === 'REJECTED' ? 'danger' : 'warn'}`}>
                        {r.status.toLowerCase().replace(/_/g, ' ')}
                      </span>
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
