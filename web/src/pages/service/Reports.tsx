import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api, qs } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { DataList, type Column } from '../../components/DataList';
import { DocumentApproval } from '../../components/ApprovalStepper';
import { Attachments } from '../../components/Attachments';
import { Stat } from '../../components/charts';
import { RecordHeader } from '../../components/RecordHeader';
import { NumberInput } from '../../components/NumberInput';
import { useBackLink, useUnsavedChanges } from '../../components/Navigation';
import {
  Checkbox,
  Empty,
  ErrorBox,
  Field,
  Loading,
  Modal,
  ModalFoot,
  StatusBadge,
  formatDate,
  formatMoney,
  useToast,
  type Tone,
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

export const KIND_LABEL: Record<string, string> = Object.fromEntries(KINDS.map((k) => [k.value, k.label]));

/** The document type a report of each kind is approved under — mirrors the API. */
export const REPORT_DOC_TYPE: Record<string, string> = {
  COMMISSIONING: 'commissioning_report',
  PREVENTIVE_MAINTENANCE: 'pm_report',
  INSPECTION: 'inspection_report',
  CORRECTIVE: 'inspection_report',
};

/** Which permission covers a report of each kind — mirrors the API. */
export function reportPermission(kind: string, action: string): string {
  if (kind === 'COMMISSIONING') return `gops.commissioning_reports.${action}`;
  if (kind === 'PREVENTIVE_MAINTENANCE') return `gops.pm_reports.${action}`;
  return `gops.inspection_reports.${action}`;
}

/** REJECTED reads "Returned" on this screen — the report goes back to its author. */
const REPORT_TONES: Record<string, Tone> = { REJECTED: 'warn' };

const STATUSES = [
  { value: 'DRAFT', label: 'Draft' },
  { value: 'PENDING_APPROVAL', label: 'Pending approval' },
  { value: 'APPROVED', label: 'Approved' },
  { value: 'REJECTED', label: 'Returned' },
];

import { todayLocal } from '../../lib/day';

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
  visit: {
    id: string;
    number: string;
    dueDate: string;
    sequence: number | null;
    jobOrder: { id: string; number: string; status: string } | null;
  } | null;
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
const PRESET_BY_PATH: Record<string, { kind: string; title: string }> = {
  '/g-ops/commissioning': { kind: 'COMMISSIONING', title: 'Commissioning Reports' },
  '/g-ops/pm': { kind: 'PREVENTIVE_MAINTENANCE', title: 'Preventive Maintenance' },
  '/g-ops/inspections': { kind: 'INSPECTION', title: 'Service Inspections' },
};

/**
 * Where "← Back to …" goes from a report: the menu entry of its kind. The
 * report's own path is not a menu entry, so the Shell alone would send it to
 * the module's dashboard. A corrective report has no menu of its own and goes
 * back to the one list of every report, narrowed to its kind.
 */
function reportListFor(kind: string): { to: string; label: string } {
  const entry = Object.entries(PRESET_BY_PATH).find(([, p]) => p.kind === kind);
  return entry
    ? { to: entry[0], label: entry[1].title }
    : { to: `/g-ops/service-reports?kind=${kind}`, label: 'Service Reports' };
}

export function ServiceReports() {
  const { can } = useAuth();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const preset = PRESET_BY_PATH[pathname];
  const [params, setParams] = useSearchParams();
  // `?new=1&visitId=` is how the schedule and a job order hand a visit over
  // ("Write report"); `?visit=` is the older spelling of the same thing.
  const handedVisit = params.get('visitId') ?? params.get('visit');
  const [writing, setWriting] = useState(params.get('new') === '1' || !!handedVisit);
  const [reportPreset] = useState(() => (handedVisit ? { visitId: handedVisit } : undefined));
  const [reload, setReload] = useState(0);

  function closeWriting() {
    setWriting(false);
    if (params.has('new') || params.has('visitId') || params.has('visit')) {
      const next = new URLSearchParams(params);
      next.delete('new');
      next.delete('visitId');
      next.delete('visit');
      setParams(next, { replace: true });
    }
  }

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
      render: (r) => <StatusBadge status={r.status} extra={REPORT_TONES} />,
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
              + New service report
            </button>
          ) : null
        }
      />

      {writing && (
        <NewReportModal
          preset={reportPreset}
          onClose={closeWriting}
          onCreated={(id) => {
            setWriting(false);
            setReload((r) => r + 1);
            navigate(`/g-ops/service-reports/${id}`, { replace: true });
          }}
        />
      )}
    </div>
  );
}

export interface ReportPreset {
  visitId?: string;
  customerId?: string;
  assetId?: string;
  kind?: string;
  contractId?: string;
  siteId?: string;
}

interface PickerVisit {
  id: string;
  number: string;
  kind: string;
  status: string;
  dueDate: string;
  customer: { id: string; name: string };
  site: { id: string } | null;
  asset: { id: string } | null;
  contract: { id: string } | null;
  report: { id: string } | null;
}

/**
 * Starting a report. Opened from the list, and — with a `preset` — from a
 * visit on the schedule or a job order, so the report is written against
 * that visit without re-finding it in a dropdown.
 */
export function NewReportModal({
  onClose,
  onCreated,
  preset,
}: {
  onClose: () => void;
  onCreated: (id: string) => void;
  preset?: ReportPreset;
}) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [templates, setTemplates] = useState<Template[]>([]);
  const [customers, setCustomers] = useState<{ id: string; name: string }[]>([]);
  const [assets, setAssets] = useState<{ id: string; code: string; name: string; serialNo: string | null }[]>([]);
  const [visits, setVisits] = useState<PickerVisit[]>([]);

  const [form, setForm] = useState({
    kind: preset?.kind ?? 'PREVENTIVE_MAINTENANCE',
    templateId: '',
    visitId: preset?.visitId ?? '',
    customerId: preset?.customerId ?? '',
    assetId: preset?.assetId ?? '',
    contractId: preset?.contractId ?? '',
    siteId: preset?.siteId ?? '',
    performedAt: todayLocal(),
  });
  const locked = !!preset?.visitId;

  /** A chosen visit decides the kind, the customer, the machine and the contract. */
  const takeVisit = useCallback((v: PickerVisit | undefined, visitId: string) => {
    setForm((f) => ({
      ...f,
      visitId,
      kind: v?.kind ?? f.kind,
      customerId: v?.customer.id ?? f.customerId,
      assetId: v ? (v.asset?.id ?? '') : f.assetId,
      contractId: v ? (v.contract?.id ?? '') : '',
      siteId: v ? (v.site?.id ?? '') : f.siteId,
    }));
  }, []);

  useEffect(() => {
    api.get<Template[]>('/report-templates').then(setTemplates).catch(() => {});
    api.get<{ rows: { id: string; name: string }[] }>('/customers?pageSize=200').then((d) => setCustomers(d.rows)).catch(() => {});
    // MISSED as well as SCHEDULED: a late visit still has to be reported, or
    // it can never complete.
    api
      .get<{ rows: PickerVisit[] }>('/service-visits?pageSize=200&statuses=SCHEDULED,MISSED&sort=dueDate&dir=asc')
      .then(async (d) => {
        let rows = d.rows.filter((v) => !v.report);
        if (preset?.visitId && !rows.some((v) => v.id === preset.visitId)) {
          const one = await api.get<PickerVisit>(`/service-visits/${preset.visitId}`).catch(() => null);
          if (one) rows = [one, ...rows];
        }
        setVisits(rows);
        if (preset?.visitId) takeVisit(rows.find((v) => v.id === preset.visitId), preset.visitId);
      })
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
      // The server fills customer, site, machine, contract and job from the
      // visit whatever is sent; sending them keeps this form's own preview
      // honest about what covers the work.
      const created = await api.post<{ id: string }>('/service-reports', {
        kind: form.kind,
        templateId: form.templateId || undefined,
        visitId: form.visitId || null,
        customerId: form.customerId,
        siteId: form.siteId || null,
        assetId: form.assetId || null,
        contractId: form.contractId || null,
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

  const chosen = visits.find((v) => v.id === form.visitId);

  return (
    <Modal
      title={chosen ? `New service report for ${chosen.number}` : 'New service report'}
      onClose={onClose}
      footer={
        <ModalFoot onCancel={onClose} busy={busy}>
          <button
            className="btn btn-primary"
            onClick={create}
            disabled={busy || !form.customerId || !form.templateId}
          >
            {busy ? 'Saving…' : 'Save'}
          </button>
        </ModalFoot>
      }
    >
      <ErrorBox error={error} />

      <Field label="What kind of visit?">
        <select
          value={form.kind}
          disabled={!!form.visitId}
          onChange={(e) => setForm({ ...form, kind: e.target.value })}
        >
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

      {(visits.length > 0 || locked) && (
        <Field
          label="Against a visit on the schedule"
          hint={locked ? 'Opened from the visit' : 'Leave empty for a call-out nobody scheduled'}
        >
          <select
            value={form.visitId}
            disabled={locked}
            onChange={(e) => takeVisit(visits.find((x) => x.id === e.target.value), e.target.value)}
          >
            <option value="">— unscheduled —</option>
            {visits.map((v) => (
              <option key={v.id} value={v.id}>
                {v.number} — {v.customer.name} — due {v.dueDate.slice(0, 10)}
                {v.status === 'MISSED' ? ' (missed)' : ''}
              </option>
            ))}
          </select>
        </Field>
      )}

      <div className="grid grid-2">
        <Field label="Customer">
          <select
            value={form.customerId}
            disabled={!!form.visitId}
            onChange={(e) => setForm({ ...form, customerId: e.target.value, assetId: '' })}
          >
            <option value="">— choose —</option>
            {chosen && !customers.some((c) => c.id === chosen.customer.id) && (
              <option value={chosen.customer.id}>{chosen.customer.name}</option>
            )}
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

      {form.contractId && (
        <div className="alert info">Covered by the service contract this visit belongs to — not billed by default.</div>
      )}
    </Modal>
  );
}

// ── Filling in and reading a report ──────────────────────────────────────────

export function ServiceReportDetail() {
  const { id } = useParams<{ id: string }>();
  const toast = useToast();
  const { me, can } = useAuth();
  const [row, setRow] = useState<Report | null>(null);
  const [reload, setReload] = useState(0);
  const [error, setError] = useState<unknown>(null);
  /** A refused Save draft or Submit: shown under the header, never in place of the page. */
  const [actionError, setActionError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState<Record<string, Record<string, unknown>>>({});
  const [meta, setMeta] = useState({ findings: '', recommendations: '', customerSignedBy: '', billable: false });
  const [dirty, setDirty] = useState(false);
  // A report is filled in on site: leaving with typed readings asks first.
  useUnsavedChanges(dirty);
  const backTo = row ? reportListFor(row.kind) : null;
  useBackLink(backTo?.to, backTo?.label);

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
      setReload((n) => n + 1);
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

  const isAuthor = row.performedBy.id === me?.user.id;
  // A returned report is corrected and sent again; whoever holds edit_all for
  // this kind can correct it too, but only its author sends it for approval.
  const editable =
    (row.status === 'DRAFT' || row.status === 'REJECTED') &&
    (isAuthor || !!me?.user.isSuperAdmin || can(reportPermission(row.kind, 'edit_all')));
  const canSubmit = editable && (isAuthor || !!me?.user.isSuperAdmin);

  function set(sectionKey: string, fieldKey: string, value: unknown) {
    setDraft((d) => ({ ...d, [sectionKey]: { ...(d[sectionKey] ?? {}), [fieldKey]: value } }));
    setDirty(true);
  }

  async function save() {
    setBusy(true);
    setActionError(null);
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
      setActionError(err);
    } finally {
      setBusy(false);
    }
  }

  async function submit() {
    setBusy(true);
    setActionError(null);
    try {
      await api.patch(`/service-reports/${id}`, {
        data: draft,
        findings: meta.findings || null,
        recommendations: meta.recommendations || null,
        customerSignedBy: meta.customerSignedBy || null,
        billable: meta.billable,
      });
      // Saved: a submit refused after this leaves nothing unsaved behind.
      setDirty(false);
      await api.post(`/service-reports/${id}/submit`);
      toast('ok', 'Submitted for approval');
      await load();
    } catch (err) {
      setActionError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <RecordHeader
        type={`${KIND_LABEL[row.kind] ?? row.kind} report`}
        code={row.number}
        title={row.customer.name}
        status={row.status}
        statusExtra={REPORT_TONES}
        statusLabel={row.status === 'REJECTED' ? 'Returned' : undefined}
        meta={
          <>
            {can('gops.customers.view_all') ? (
              <Link to={`/g-ops/customers/${row.customer.id}`}>{row.customer.name}</Link>
            ) : (
              row.customer.name
            )}
            {row.asset && (
              <>
                {' · '}
                <Link to={`/g-ops/installed-base/${row.asset.id}`}>{row.asset.name}</Link>
              </>
            )}
            {' · '}
            {formatDate(row.performedAt)} by {row.performedBy.name}
            {row.visit && (
              <>
                {' · visit '}
                <Link to={`/g-ops/visits?visit=${row.visit.id}`} className="mono">
                  {row.visit.number}
                </Link>
              </>
            )}
          </>
        }
        actions={
          editable && (
            <>
              <button className="btn" onClick={save} disabled={busy || !dirty}>
                {busy ? 'Saving…' : 'Save draft'}
              </button>
              {canSubmit && (
                <button
                  className="btn btn-primary"
                  onClick={submit}
                  disabled={busy || missing.length > 0 || !meta.customerSignedBy.trim()}
                >
                  Submit for approval
                </button>
              )}
            </>
          )
        }
      />

      <ErrorBox error={actionError} />

      <DocumentApproval documentType={REPORT_DOC_TYPE[row.kind]} documentId={row.id} reloadToken={reload} />

      {row.status === 'REJECTED' && (
        <div className="alert warn">
          Returned by the approver. Correct it and submit it again — the visit closes when the report
          is approved.
        </div>
      )}

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

      {(row.visit || row.contract || row.job) && (
        <div className="card">
          <h3 className="card-title">Where this work came from</h3>
          <dl className="kv">
            {row.visit && (
              <>
                <dt>Against visit</dt>
                <dd>
                  <Link to={`/g-ops/visits?visit=${row.visit.id}`} className="mono">
                    {row.visit.number}
                  </Link>{' '}
                  <span className="faint">due {formatDate(row.visit.dueDate)}</span>
                </dd>
              </>
            )}
            {row.visit?.jobOrder && (
              <>
                <dt>Job order</dt>
                <dd>
                  <Link to={`/g-ops/job-orders/${row.visit.jobOrder.id}`} className="mono">
                    {row.visit.jobOrder.number}
                  </Link>{' '}
                  <StatusBadge status={row.visit.jobOrder.status} />
                </dd>
              </>
            )}
            {row.contract && (
              <>
                <dt>Contract</dt>
                <dd>
                  <Link to={`/g-ops/service-contracts/${row.contract.id}`} className="mono">
                    {row.contract.number}
                  </Link>
                </dd>
              </>
            )}
            {row.job && (
              <>
                <dt>Charged to</dt>
                <dd>
                  <Link to={`/g-ops/projects/${row.job.id}`} className="mono">
                    {row.job.number}
                  </Link>{' '}
                  <span className="faint">{row.job.name}</span>
                </dd>
              </>
            )}
          </dl>
        </div>
      )}

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
                  <div key={field.key} className="svc-check-cell">
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
                  <div key={field.key} className="svc-span-all">
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
              if (field.type === 'number') {
                return (
                  <Field key={field.key} label={label}>
                    <NumberInput
                      kind="decimal"
                      value={(value as number | string | null | undefined) ?? ''}
                      onChange={(e) => {
                        // Stored as a number, as the old number box stored it ('' read as 0).
                        const n = Number(e.target.value);
                        set(section.key, field.key, Number.isFinite(n) ? n : 0);
                      }}
                    />
                  </Field>
                );
              }
              return (
                <Field key={field.key} label={label}>
                  <input
                    type={field.type === 'date' ? 'date' : 'text'}
                    value={(value as string) ?? ''}
                    onChange={(e) => set(section.key, field.key, e.target.value)}
                  />
                </Field>
              );
            })}
          </div>
          {section.allowPhotos && (
            <Attachments
              entityType="service_report"
              entityId={`${row.id}~${section.key}`}
              title={`Photos — ${section.title}`}
              canEdit={editable}
            />
          )}
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
          </dl>
        )}
      </div>

      <Attachments
        entityType="service_report"
        entityId={row.id}
        title="Photos and documents"
        hint="The signed service slip, readings off the panel, anything the report refers to"
        canEdit={editable}
      />
    </div>
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

      <div className="kpi-grid svc-kpis">
        <Stat
          label="Contracts to renew"
          value={data.counts.contracts}
          hint={`${formatMoney(data.contractValue)} of cover`}
          figure
        />
        <Stat
          label="Warranties lapsing"
          value={data.counts.warranties}
          hint="machines with no contract behind them"
          accent={data.counts.warranties > 0 ? 'warn' : undefined}
        />
        <Stat
          label="Already lapsed"
          value={data.counts.alreadyLapsed}
          hint="the calls that are late"
          accent={data.counts.alreadyLapsed > 0 ? 'danger' : undefined}
        />
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
                      <StatusBadge
                        status={r.daysRemaining < 0 ? 'LAPSED' : r.daysRemaining <= 30 ? 'SOON' : 'LATER'}
                        extra={{ LAPSED: 'danger', SOON: 'warn', LATER: '' }}
                        label={r.daysRemaining < 0 ? `${-r.daysRemaining} days ago` : `${r.daysRemaining} days`}
                      />
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
