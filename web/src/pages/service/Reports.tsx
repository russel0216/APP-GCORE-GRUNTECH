import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import { api, qs } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { DataList, type Column } from '../../components/DataList';
import {
  Checkbox,
  Empty,
  ErrorBox,
  Field,
  Loading,
  Modal,
  formatDate,
  formatMoney,
  useToast,
} from '../../components/ui';

/**
 * Service reports — commissioning, PM, inspection and corrective.
 *
 * One document type with a kind, rather than three near-identical screens: the
 * fields that differ between them live in the **template**, which is data a
 * service engineer edits (model §4.5). A template that has been used is
 * immutable — editing publishes a new version, and an old report still renders
 * the way it was signed.
 */

export const KINDS = [
  { value: 'COMMISSIONING', label: 'Commissioning' },
  { value: 'PREVENTIVE_MAINTENANCE', label: 'Preventive maintenance' },
  { value: 'INSPECTION', label: 'Inspection' },
  { value: 'CORRECTIVE', label: 'Corrective' },
];

const KIND_LABEL = Object.fromEntries(KINDS.map((k) => [k.value, k.label]));

const STATUSES = [
  { value: 'DRAFT', label: 'Draft' },
  { value: 'PENDING_APPROVAL', label: 'Pending approval' },
  { value: 'APPROVED', label: 'Approved' },
  { value: 'REJECTED', label: 'Returned' },
];

import { statusTone as tone } from '../../components/ui';

export interface TemplateField {
  key: string;
  label: string;
  type: 'text' | 'number' | 'boolean' | 'select' | 'pass_fail' | 'date' | 'note';
  options?: string[];
  unit?: string;
  required?: boolean;
}

export interface TemplateSection {
  key: string;
  title: string;
  help?: string;
  allowPhotos?: boolean;
  fields: TemplateField[];
}

export interface Template {
  id: string;
  key: string;
  version: number;
  kind: string;
  name: string;
  description: string | null;
  sections: TemplateSection[];
  isCurrent: boolean;
  isActive: boolean;
  createdBy?: { id: string; name: string } | null;
  _count?: { reports: number };
}

interface Report {
  id: string;
  number: string;
  kind: string;
  status: string;
  performedAt: string;
  findings: string | null;
  recommendations: string | null;
  billable: boolean;
  underWarranty: boolean;
  customerSignedBy: string | null;
  customerSignedAt: string | null;
  data: Record<string, Record<string, unknown>>;
  customer: { id: string; code: string; name: string };
  site: { id: string; name: string; city: string | null } | null;
  asset: {
    id: string;
    code: string;
    name: string;
    serialNo: string | null;
    model: string | null;
    warrantyEndsAt: string | null;
  } | null;
  contract: { id: string; number: string; endsAt: string } | null;
  job: { id: string; number: string; name: string } | null;
  visit: { id: string; number: string; dueDate: string; sequence: number | null } | null;
  template: Template;
  performedBy: { id: string; name: string };
  photos?: { id: string; fileName: string; caption: string | null }[];
}

/**
 * The three report menus - Commissioning Reports, Preventive Maintenance and
 * Service Inspections - are one screen with a preset kind, because what differs
 * between them lives in the template rather than in code.
 *
 * Each keeps its OWN path. They used to redirect to /g-ops/service-reports with
 * a ?kind= nobody read, which cost two things: the preset never applied, so all
 * three menus showed every report; and the menu could not highlight a path the
 * registry does not declare, so all three lit up nothing.
 */
const PRESET_BY_PATH: Record<string, { kind: string; title: string; blurb: string }> = {
  '/g-ops/commissioning': {
    kind: 'COMMISSIONING',
    title: 'Commissioning Reports',
    blurb:
      'The handover record for equipment put into service - and what starts its warranty running.',
  },
  '/g-ops/pm': {
    kind: 'PREVENTIVE_MAINTENANCE',
    title: 'Preventive Maintenance',
    blurb:
      'Scheduled visits against a contract. A visit completes when its report is approved, not when the engineer leaves site.',
  },
  '/g-ops/inspections': {
    kind: 'INSPECTION',
    title: 'Service Inspections',
    blurb: 'Inspections and breakdown calls, on the same template engine as the rest.',
  },
};

export function ServiceReports() {
  const { can } = useAuth();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const preset = PRESET_BY_PATH[pathname];
  const [writing, setWriting] = useState(false);
  const [reload, setReload] = useState(0);

  const columns: Column<Report>[] = [
    {
      key: 'number',
      label: 'Number',
      sortKey: 'number',
      width: '150px',
      render: (r) => <span className="mono">{r.number}</span>,
    },
    {
      key: 'kind',
      label: 'Kind',
      render: (r) => <span className="badge">{KIND_LABEL[r.kind] ?? r.kind}</span>,
    },
    {
      key: 'customer',
      label: 'Where',
      render: (r) => (
        <div>
          <div>{r.customer.name}</div>
          <div className="faint">{r.asset?.name ?? r.site?.name ?? '—'}</div>
        </div>
      ),
    },
    {
      key: 'performedAt',
      label: 'Performed',
      sortKey: 'performedAt',
      render: (r) => (
        <div>
          <div>{formatDate(r.performedAt)}</div>
          <div className="faint">{r.performedBy.name}</div>
        </div>
      ),
    },
    {
      key: 'cover',
      label: 'Covered by',
      render: (r) =>
        r.underWarranty ? (
          <span className="badge ok">warranty</span>
        ) : r.contract ? (
          <span className="badge info">contract</span>
        ) : r.billable ? (
          <span className="badge warn">billable</span>
        ) : (
          <span className="faint">—</span>
        ),
    },
    {
      key: 'signed',
      label: 'Signed',
      optional: true,
      render: (r) =>
        r.customerSignedBy ? (
          <span className="faint">{r.customerSignedBy}</span>
        ) : (
          <span className="badge warn">unsigned</span>
        ),
    },
    {
      key: 'status',
      label: 'Status',
      render: (r) => (
        <span className={`badge ${tone(r.status)}`}>{r.status.toLowerCase().replace(/_/g, ' ')}</span>
      ),
    },
  ];

  const canWrite =
    can('gops.pm_reports.create') ||
    can('gops.commissioning_reports.create') ||
    can('gops.inspection_reports.create');

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>{preset?.title ?? 'Service Reports'}</h1>
          <p>
            {preset?.blurb ??
              'Commissioning, preventive maintenance, inspections and breakdown calls.'}{' '}
            The form comes from a template, so the fields are yours to change — and an old report
            keeps rendering the way it was signed.
          </p>
        </div>
      </div>

      <DataList<Report>
        listKey="service-reports"
        endpoint="/service-reports"
        columns={columns}
        rowKey={(r) => r.id}
        scoped
        initialFilters={preset ? { kind: preset.kind } : undefined}
        reloadToken={reload}
        searchPlaceholder="Search number, findings, customer, serial…"
        emptyTitle="No reports yet"
        onRowClick={(r) => navigate(`/g-ops/service-reports/${r.id}`)}
        filters={[
          { key: 'kind', label: 'Kind', options: KINDS },
          { key: 'status', label: 'Status', options: STATUSES },
          {
            key: 'billable',
            label: 'Billable',
            options: [
              { value: 'true', label: 'Billable' },
              { value: 'false', label: 'Covered' },
            ],
          },
        ]}
        actions={
          canWrite ? (
            <button className="btn btn-primary btn-sm" onClick={() => setWriting(true)}>
              + New report
            </button>
          ) : null
        }
      />

      {writing && (
        <NewReportModal
          onClose={() => setWriting(false)}
          onCreated={(id) => {
            setWriting(false);
            setReload((r) => r + 1);
            navigate(`/g-ops/service-reports/${id}`);
          }}
        />
      )}
    </div>
  );
}

function NewReportModal({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (id: string) => void;
}) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [templates, setTemplates] = useState<Template[]>([]);
  const [customers, setCustomers] = useState<{ id: string; name: string }[]>([]);
  const [assets, setAssets] = useState<{ id: string; code: string; name: string; serialNo: string | null }[]>([]);
  const [visits, setVisits] = useState<
    { id: string; number: string; dueDate: string; customer: { id: string; name: string }; asset: { id: string } | null; contract: { id: string } | null }[]
  >([]);

  const [form, setForm] = useState({
    kind: 'PREVENTIVE_MAINTENANCE',
    templateId: '',
    visitId: '',
    customerId: '',
    assetId: '',
    performedAt: new Date().toISOString().slice(0, 10),
  });

  useEffect(() => {
    api.get<Template[]>('/report-templates').then(setTemplates).catch(() => {});
    api.get<{ rows: { id: string; name: string }[] }>('/customers?pageSize=200').then((d) => setCustomers(d.rows)).catch(() => {});
    api
      .get<{ rows: typeof visits }>('/service-visits?pageSize=100&status=SCHEDULED')
      .then((d) => setVisits(d.rows))
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (!form.customerId) {
      setAssets([]);
      return;
    }
    api
      .get<{ rows: typeof assets }>(`/installed-assets?pageSize=200&customerId=${form.customerId}`)
      .then((d) => setAssets(d.rows))
      .catch(() => setAssets([]));
  }, [form.customerId]);

  const forKind = templates.filter((t) => t.kind === form.kind);

  useEffect(() => {
    setForm((f) => ({ ...f, templateId: forKind[0]?.id ?? '' }));
    // Re-picking the template whenever the kind changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form.kind, templates.length]);

  async function create() {
    setBusy(true);
    setError(null);
    try {
      const created = await api.post<{ id: string }>('/service-reports', {
        kind: form.kind,
        templateId: form.templateId || undefined,
        visitId: form.visitId || null,
        customerId: form.customerId,
        assetId: form.assetId || null,
        performedAt: form.performedAt,
        data: {},
      });
      toast('ok', 'Report started — fill it in on site');
      onCreated(created.id);
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  }

  return (
    <Modal
      title="New service report"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button
            className="btn btn-primary"
            onClick={create}
            disabled={busy || !form.customerId || !form.templateId}
          >
            {busy ? 'Starting…' : 'Start report'}
          </button>
        </>
      }
    >
      <ErrorBox error={error} />

      <Field label="What kind of visit?">
        <select value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value })}>
          {KINDS.map((k) => (
            <option key={k.value} value={k.value}>
              {k.label}
            </option>
          ))}
        </select>
      </Field>

      {forKind.length === 0 ? (
        <div className="alert warn">
          No template exists for a {KIND_LABEL[form.kind].toLowerCase()} report yet. Set one up in
          Report Templates first — the form is data, not code.
        </div>
      ) : (
        <Field label="Form to use">
          <select
            value={form.templateId}
            onChange={(e) => setForm({ ...form, templateId: e.target.value })}
          >
            {forKind.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name} (v{t.version})
              </option>
            ))}
          </select>
        </Field>
      )}

      {visits.length > 0 && (
        <Field label="Against a scheduled visit" hint="Leave empty for a call-out nobody scheduled">
          <select
            value={form.visitId}
            onChange={(e) => {
              const v = visits.find((x) => x.id === e.target.value);
              setForm({
                ...form,
                visitId: e.target.value,
                customerId: v?.customer.id ?? form.customerId,
                assetId: v?.asset?.id ?? '',
              });
            }}
          >
            <option value="">— unscheduled —</option>
            {visits.map((v) => (
              <option key={v.id} value={v.id}>
                {v.number} — {v.customer.name} — due {v.dueDate.slice(0, 10)}
              </option>
            ))}
          </select>
        </Field>
      )}

      <div className="grid grid-2">
        <Field label="Customer">
          <select
            value={form.customerId}
            onChange={(e) => setForm({ ...form, customerId: e.target.value, assetId: '' })}
          >
            <option value="">— choose —</option>
            {customers.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Performed on">
          <input
            type="date"
            value={form.performedAt}
            onChange={(e) => setForm({ ...form, performedAt: e.target.value })}
          />
        </Field>
      </div>

      <Field
        label="Which machine"
        hint="Whether the work was under warranty is decided from this machine's dates, not from a tick box"
      >
        <select value={form.assetId} onChange={(e) => setForm({ ...form, assetId: e.target.value })}>
          <option value="">— none —</option>
          {assets.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name} {a.serialNo ? `(${a.serialNo})` : ''}
            </option>
          ))}
        </select>
      </Field>
    </Modal>
  );
}

// ── Filling in and reading a report ──────────────────────────────────────────

export function ServiceReportDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const toast = useToast();
  const { me } = useAuth();
  const [row, setRow] = useState<Report | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState<Record<string, Record<string, unknown>>>({});
  const [meta, setMeta] = useState({ findings: '', recommendations: '', customerSignedBy: '', billable: false });
  const [dirty, setDirty] = useState(false);

  const load = useCallback(async () => {
    try {
      const report = await api.get<Report>(`/service-reports/${id}`);
      setRow(report);
      setDraft(report.data ?? {});
      setMeta({
        findings: report.findings ?? '',
        recommendations: report.recommendations ?? '',
        customerSignedBy: report.customerSignedBy ?? '',
        billable: report.billable,
      });
      setDirty(false);
    } catch (err) {
      setError(err);
    }
  }, [id]);

  useEffect(() => {
    load();
  }, [load]);

  const missing = useMemo(() => {
    if (!row) return [];
    const out: string[] = [];
    for (const section of row.template.sections) {
      const filled = draft[section.key] ?? {};
      for (const field of section.fields) {
        if (!field.required) continue;
        const v = filled[field.key];
        if (v === undefined || v === null || v === '') out.push(`${section.title} — ${field.label}`);
      }
    }
    return out;
  }, [row, draft]);

  if (error) return <ErrorBox error={error} />;
  if (!row) return <Loading />;

  const editable = row.status === 'DRAFT' && row.performedBy.id === me?.user.id;

  function set(sectionKey: string, fieldKey: string, value: unknown) {
    setDraft((d) => ({ ...d, [sectionKey]: { ...(d[sectionKey] ?? {}), [fieldKey]: value } }));
    setDirty(true);
  }

  async function save() {
    setBusy(true);
    setError(null);
    try {
      await api.patch(`/service-reports/${id}`, {
        data: draft,
        findings: meta.findings || null,
        recommendations: meta.recommendations || null,
        customerSignedBy: meta.customerSignedBy || null,
        billable: meta.billable,
      });
      toast('ok', 'Saved');
      await load();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      await api.patch(`/service-reports/${id}`, {
        data: draft,
        findings: meta.findings || null,
        recommendations: meta.recommendations || null,
        customerSignedBy: meta.customerSignedBy || null,
        billable: meta.billable,
      });
      await api.post(`/service-reports/${id}/submit`);
      toast('ok', 'Sent for approval');
      await load();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <div className="breadcrumb">
        <button className="btn btn-ghost btn-sm" onClick={() => navigate('/g-ops/service-reports')}>
          ← Service reports
        </button>
      </div>

      <div className="page-head">
        <div>
          <h1>
            <span className="mono">{row.number}</span>{' '}
            <span className={`badge ${tone(row.status)}`}>
              {row.status.toLowerCase().replace(/_/g, ' ')}
            </span>
          </h1>
          <p>
            {KIND_LABEL[row.kind]} · {row.customer.name}
            {row.asset && (
              <>
                {' · '}
                <Link to={`/g-ops/installed-base/${row.asset.id}`}>{row.asset.name}</Link>
              </>
            )}
            {' · '}
            {formatDate(row.performedAt)} by {row.performedBy.name}
          </p>
        </div>
        {editable && (
          <div className="row">
            <button className="btn btn-sm" onClick={save} disabled={busy || !dirty}>
              {busy ? 'Saving…' : 'Save draft'}
            </button>
            <button
              className="btn btn-primary btn-sm"
              onClick={submit}
              disabled={busy || missing.length > 0 || !meta.customerSignedBy.trim()}
            >
              Send for approval
            </button>
          </div>
        )}
      </div>

      {editable && (missing.length > 0 || !meta.customerSignedBy.trim()) && (
        <div className="alert warn">
          {missing.length > 0 && (
            <>
              {missing.length} required field{missing.length === 1 ? '' : 's'} still blank:{' '}
              {missing.slice(0, 3).join('; ')}
              {missing.length > 3 && `, and ${missing.length - 3} more`}.{' '}
            </>
          )}
          {!meta.customerSignedBy.trim() &&
            'Somebody on site has to sign for it — a report nobody acknowledged is an assertion, not a record.'}{' '}
          A draft saves without any of this, so fill it in on site and finish later.
        </div>
      )}

      <div className="alert info">
        Filled in on <strong>{row.template.name}</strong> v{row.template.version}.
        {row.underWarranty
          ? ' This machine was inside its warranty on the day the work was done, so the visit is covered.'
          : row.contract
            ? ' Covered by an active service contract.'
            : row.billable
              ? ' Out of warranty and outside any contract — this visit is billable.'
              : ''}
      </div>

      {row.template.sections.map((section) => (
        <div key={section.key} className="card">
          <h3 className="card-title">{section.title}</h3>
          {section.help && <p className="muted">{section.help}</p>}
          <div className="grid grid-2">
            {section.fields.map((field) => {
              const value = draft[section.key]?.[field.key];
              const label = `${field.label}${field.unit ? ` (${field.unit})` : ''}${field.required ? ' *' : ''}`;

              if (!editable) {
                return (
                  <Field key={field.key} label={label}>
                    <div className="readback">
                      {value === undefined || value === null || value === '' ? (
                        <span className="faint">—</span>
                      ) : typeof value === 'boolean' ? (
                        value ? 'yes' : 'no'
                      ) : (
                        String(value)
                      )}
                    </div>
                  </Field>
                );
              }

              if (field.type === 'boolean') {
                return (
                  <div key={field.key} style={{ alignSelf: 'end', paddingBottom: 12 }}>
                    <Checkbox
                      checked={value === true}
                      onChange={(v) => set(section.key, field.key, v)}
                      label={label}
                    />
                  </div>
                );
              }
              if (field.type === 'pass_fail' || field.type === 'select') {
                const options = field.type === 'pass_fail' ? ['Pass', 'Fail', 'N/A'] : (field.options ?? []);
                return (
                  <Field key={field.key} label={label}>
                    <select
                      value={(value as string) ?? ''}
                      onChange={(e) => set(section.key, field.key, e.target.value)}
                    >
                      <option value="">— choose —</option>
                      {options.map((o) => (
                        <option key={o} value={o}>
                          {o}
                        </option>
                      ))}
                    </select>
                  </Field>
                );
              }
              if (field.type === 'note') {
                return (
                  <div key={field.key} style={{ gridColumn: '1 / -1' }}>
                    <Field label={label}>
                      <textarea
                        rows={2}
                        value={(value as string) ?? ''}
                        onChange={(e) => set(section.key, field.key, e.target.value)}
                      />
                    </Field>
                  </div>
                );
              }
              return (
                <Field key={field.key} label={label}>
                  <input
                    type={field.type === 'number' ? 'number' : field.type === 'date' ? 'date' : 'text'}
                    step={field.type === 'number' ? 'any' : undefined}
                    value={(value as string) ?? ''}
                    onChange={(e) =>
                      set(
                        section.key,
                        field.key,
                        field.type === 'number' ? Number(e.target.value) : e.target.value,
                      )
                    }
                  />
                </Field>
              );
            })}
          </div>
        </div>
      ))}

      <div className="card">
        <h3 className="card-title">Findings and handover</h3>
        {editable ? (
          <>
            <Field label="What was found">
              <textarea
                rows={3}
                value={meta.findings}
                onChange={(e) => {
                  setMeta({ ...meta, findings: e.target.value });
                  setDirty(true);
                }}
              />
            </Field>
            <Field label="Recommendations">
              <textarea
                rows={3}
                value={meta.recommendations}
                onChange={(e) => {
                  setMeta({ ...meta, recommendations: e.target.value });
                  setDirty(true);
                }}
              />
            </Field>
            <Checkbox
              checked={meta.billable}
              onChange={(v) => {
                setMeta({ ...meta, billable: v });
                setDirty(true);
              }}
              label="This visit is billable"
            />
            <Field label="Acknowledged on site by" hint="The name of whoever signed for the work">
              <input
                value={meta.customerSignedBy}
                onChange={(e) => {
                  setMeta({ ...meta, customerSignedBy: e.target.value });
                  setDirty(true);
                }}
              />
            </Field>
          </>
        ) : (
          <dl className="kv">
            <dt>Findings</dt>
            <dd>{row.findings ?? <span className="faint">none recorded</span>}</dd>
            <dt>Recommendations</dt>
            <dd>{row.recommendations ?? <span className="faint">none</span>}</dd>
            <dt>Billable</dt>
            <dd>{row.billable ? 'yes' : 'no'}</dd>
            <dt>Signed by</dt>
            <dd>
              {row.customerSignedBy ?? <span className="faint">unsigned</span>}
              {row.customerSignedAt && (
                <span className="faint"> on {formatDate(row.customerSignedAt)}</span>
              )}
            </dd>
            {row.visit && (
              <>
                <dt>Against visit</dt>
                <dd className="mono">{row.visit.number}</dd>
              </>
            )}
          </dl>
        )}
      </div>
    </div>
  );
}

// ── The PM schedule across every contract ────────────────────────────────────

interface Visit {
  id: string;
  number: string;
  kind: string;
  status: string;
  sequence: number | null;
  dueDate: string;
  performedAt: string | null;
  daysUntilDue: number;
  notes: string | null;
  contract: { id: string; number: string; job: { id: string; number: string; name: string } } | null;
  customer: { id: string; name: string };
  site: { id: string; name: string; city: string | null } | null;
  asset: { id: string; code: string; name: string; serialNo: string | null } | null;
  assignedTo: { id: string; name: string } | null;
  report: { id: string; number: string; status: string } | null;
}

export function PmSchedule() {
  const { can } = useAuth();
  const navigate = useNavigate();
  const [assigning, setAssigning] = useState<Visit | null>(null);
  const [reload, setReload] = useState(0);

  const columns: Column<Visit>[] = [
    {
      key: 'number',
      label: 'Visit',
      sortKey: 'number',
      width: '140px',
      render: (r) => (
        <div>
          <span className="mono">{r.number}</span>
          {r.sequence && <div className="faint">visit {r.sequence}</div>}
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
          {r.status === 'SCHEDULED' && (
            <div className={`faint ${r.daysUntilDue < 0 ? 'warn' : ''}`}>
              {r.daysUntilDue < 0 ? `${-r.daysUntilDue} days overdue` : `in ${r.daysUntilDue} days`}
            </div>
          )}
        </div>
      ),
    },
    {
      key: 'customer',
      label: 'Where',
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
      render: (r) => <span className="badge">{KIND_LABEL[r.kind] ?? r.kind}</span>,
      optional: true,
    },
    {
      key: 'contract',
      label: 'Contract',
      render: (r) =>
        r.contract ? (
          <Link to={`/g-ops/service-contracts/${r.contract.id}`} className="mono">
            {r.contract.number}
          </Link>
        ) : (
          <span className="faint">unscheduled call</span>
        ),
    },
    {
      key: 'assignedTo',
      label: 'Engineer',
      render: (r) =>
        r.assignedTo ? (
          r.assignedTo.name
        ) : (
          <span className="badge warn">unassigned</span>
        ),
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
      render: (r) => (
        <span
          className={`badge ${r.status === 'COMPLETED' ? 'ok' : r.status === 'MISSED' ? 'danger' : 'warn'}`}
        >
          {r.status.toLowerCase()}
        </span>
      ),
    },
  ];

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>PM Schedule</h1>
          <p>
            Every visit a contract implies, plus the call-outs nobody scheduled. A visit is only
            complete once its report has been approved — marking it done when the engineer left
            site would count a visit nobody has checked.
          </p>
        </div>
      </div>

      <DataList<Visit>
        listKey="service-visits"
        endpoint="/service-visits"
        columns={columns}
        rowKey={(r) => r.id}
        scoped
        reloadToken={reload}
        searchPlaceholder="Search visit number, customer, machine…"
        emptyTitle="Nothing scheduled"
        emptyHint="Activating a service contract writes its schedule."
        onRowClick={can('gops.pm_reports.create') ? (r) => setAssigning(r) : undefined}
        filters={[
          {
            key: 'status',
            label: 'Status',
            options: [
              { value: 'SCHEDULED', label: 'Scheduled' },
              { value: 'COMPLETED', label: 'Completed' },
              { value: 'MISSED', label: 'Missed' },
              { value: 'CANCELLED', label: 'Cancelled' },
            ],
          },
          { key: 'due', label: 'Due', options: [{ value: 'true', label: 'Due or overdue' }] },
          { key: 'kind', label: 'Kind', options: KINDS },
        ]}
      />

      {assigning && (
        <AssignVisitModal
          visit={assigning}
          onClose={() => setAssigning(null)}
          onSaved={() => {
            setAssigning(null);
            setReload((r) => r + 1);
          }}
          onReport={(visitId) => navigate(`/g-ops/service-reports?visit=${visitId}`)}
        />
      )}
    </div>
  );
}

function AssignVisitModal({
  visit,
  onClose,
  onSaved,
}: {
  visit: Visit;
  onClose: () => void;
  onSaved: () => void;
  onReport: (visitId: string) => void;
}) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [users, setUsers] = useState<{ id: string; name: string }[]>([]);
  const [form, setForm] = useState({
    assignedToId: visit.assignedTo?.id ?? '',
    dueDate: visit.dueDate.slice(0, 10),
    notes: visit.notes ?? '',
  });

  useEffect(() => {
    api
      .get<{ rows: { id: string; name: string }[] }>(`/users${qs({ pageSize: 200 })}`)
      .then((d) => setUsers(d.rows))
      .catch(() => {});
  }, []);

  async function save() {
    setBusy(true);
    setError(null);
    try {
      await api.patch(`/service-visits/${visit.id}`, {
        assignedToId: form.assignedToId || null,
        dueDate: form.dueDate,
        notes: form.notes || null,
      });
      toast('ok', 'Visit updated');
      onSaved();
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  }

  const done = visit.status === 'COMPLETED';

  return (
    <Modal
      title={`${visit.number} — ${visit.customer.name}`}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose} disabled={busy}>
            Close
          </button>
          {!done && (
            <button className="btn btn-primary" onClick={save} disabled={busy}>
              {busy ? 'Saving…' : 'Save'}
            </button>
          )}
        </>
      }
    >
      <ErrorBox error={error} />

      {done ? (
        <div className="alert ok">
          Attended on {formatDate(visit.performedAt)}
          {visit.report && (
            <>
              {' '}
              and reported as{' '}
              <Link to={`/g-ops/service-reports/${visit.report.id}`} className="mono">
                {visit.report.number}
              </Link>
            </>
          )}
          . This visit is a record of what happened and does not change.
        </div>
      ) : (
        <>
          <div className="grid grid-2">
            <Field label="Due">
              <input
                type="date"
                value={form.dueDate}
                onChange={(e) => setForm({ ...form, dueDate: e.target.value })}
              />
            </Field>
            <Field label="Engineer">
              <select
                value={form.assignedToId}
                onChange={(e) => setForm({ ...form, assignedToId: e.target.value })}
              >
                <option value="">— unassigned —</option>
                {users.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.name}
                  </option>
                ))}
              </select>
            </Field>
          </div>
          <Field label="Notes for the engineer">
            <textarea
              rows={2}
              value={form.notes}
              onChange={(e) => setForm({ ...form, notes: e.target.value })}
            />
          </Field>
          <p className="faint" style={{ marginBottom: 0 }}>
            Write the report from Service Reports, choosing this visit — the visit closes when the
            report is approved.
          </p>
        </>
      )}
    </Modal>
  );
}

// ── Renewals ─────────────────────────────────────────────────────────────────

interface RenewalRow {
  kind: 'CONTRACT' | 'WARRANTY';
  id: string;
  reference: string;
  customerId: string;
  customerName: string;
  siteName: string | null;
  subject: string;
  endsAt: string;
  daysRemaining: number;
  value: number | null;
}

export function Renewals() {
  const [withinDays, setWithinDays] = useState(90);
  const [data, setData] = useState<{
    withinDays: number;
    rows: RenewalRow[];
    contractValue: number;
    counts: { contracts: number; warranties: number; alreadyLapsed: number };
  } | null>(null);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    setError(null);
    api
      .get<NonNullable<typeof data>>(`/aftermarket/renewals${qs({ withinDays })}`)
      .then(setData)
      .catch(setError);
  }, [withinDays]);

  if (error) return <ErrorBox error={error} />;
  if (!data) return <Loading />;

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Renewals</h1>
          <p>
            What is about to run out, and is therefore worth a phone call. Two sources on purpose:
            contracts coming up for renewal, and <strong>warranties lapsing on equipment nothing
            covers</strong> — the second is harder to see and usually the larger opportunity.
          </p>
        </div>
        <Field label="Looking ahead">
          <select value={withinDays} onChange={(e) => setWithinDays(Number(e.target.value))}>
            <option value={30}>30 days</option>
            <option value={90}>90 days</option>
            <option value={180}>6 months</option>
            <option value={365}>a year</option>
          </select>
        </Field>
      </div>

      <div className="grid grid-3" style={{ marginBottom: 18 }}>
        <div className="card">
          <div className="faint" style={{ fontSize: 11, letterSpacing: 1 }}>
            CONTRACTS TO RENEW
          </div>
          <div style={{ fontSize: 24, marginTop: 6, fontWeight: 600 }}>{data.counts.contracts}</div>
          <div className="faint" style={{ fontSize: 11, marginTop: 4 }}>
            {formatMoney(data.contractValue)} of cover
          </div>
        </div>
        <div className="card">
          <div className="faint" style={{ fontSize: 11, letterSpacing: 1 }}>
            WARRANTIES LAPSING
          </div>
          <div style={{ fontSize: 24, marginTop: 6, fontWeight: 600, color: 'var(--warn)' }}>
            {data.counts.warranties}
          </div>
          <div className="faint" style={{ fontSize: 11, marginTop: 4 }}>
            machines with no contract behind them
          </div>
        </div>
        <div className="card">
          <div className="faint" style={{ fontSize: 11, letterSpacing: 1 }}>
            ALREADY LAPSED
          </div>
          <div
            style={{
              fontSize: 24,
              marginTop: 6,
              fontWeight: 600,
              color: data.counts.alreadyLapsed > 0 ? 'var(--danger)' : undefined,
            }}
          >
            {data.counts.alreadyLapsed}
          </div>
          <div className="faint" style={{ fontSize: 11, marginTop: 4 }}>
            the calls that are late
          </div>
        </div>
      </div>

      {data.rows.length === 0 ? (
        <Empty
          title="Nothing running out in this window"
          hint="Look further ahead, or register what your finished projects installed."
        />
      ) : (
        <div className="card">
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>What</th>
                  <th>Customer</th>
                  <th>Ends</th>
                  <th className="right">Value</th>
                  <th>When</th>
                </tr>
              </thead>
              <tbody>
                {data.rows.map((r) => (
                  <tr key={`${r.kind}-${r.id}`}>
                    <td>
                      <Link
                        to={
                          r.kind === 'CONTRACT'
                            ? `/g-ops/service-contracts/${r.id}`
                            : `/g-ops/installed-base/${r.id}`
                        }
                      >
                        {r.subject}
                      </Link>
                      <div className="faint mono">{r.reference}</div>
                    </td>
                    <td>
                      {r.customerName}
                      {r.siteName && <div className="faint">{r.siteName}</div>}
                    </td>
                    <td>{formatDate(r.endsAt)}</td>
                    <td className="right mono">
                      {r.value !== null ? formatMoney(r.value) : <span className="faint">—</span>}
                    </td>
                    <td>
                      <span
                        className={`badge ${
                          r.daysRemaining < 0 ? 'danger' : r.daysRemaining <= 30 ? 'warn' : ''
                        }`}
                      >
                        {r.daysRemaining < 0
                          ? `${-r.daysRemaining} days ago`
                          : `${r.daysRemaining} days`}
                      </span>
                      <div className="section-label">
                        {r.kind === 'CONTRACT' ? 'contract' : 'warranty'}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
