import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api, openPdf, qs } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { DataList, type Column } from '../../components/DataList';
import { RecordHeader } from '../../components/RecordHeader';
import { DocumentApproval } from '../../components/ApprovalStepper';
import { Attachments } from '../../components/Attachments';
import {
  Checkbox,
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
import { todayLocal } from '../../lib/day';
import { KINDS, KIND_LABEL, NewReportModal, reportPermission } from './Reports';
import { VisitBadge } from './Schedule';
import { NumberInput } from '../../components/NumberInput';

/**
 * Job orders — a request for service work: a breakdown call, an installation,
 * a paid PM outside contract, warranty work.
 *
 * Raised by whoever took the call (usually sales), accepted by the service
 * manager, and only then dispatched: approval books exactly one visit on the
 * Service Schedule. The engineer's approved report on that visit completes
 * the order, and a chargeable one is invoiced from here, once.
 *
 * The cover — warranty, contract, chargeable, goodwill — is decided from the
 * machine's records on the requested date and may be overridden; the fact
 * (was it under warranty?) is kept either way.
 */

export const CHARGE_BASES = [
  { value: 'WARRANTY', label: 'Warranty' },
  { value: 'CONTRACT', label: 'Contract' },
  { value: 'CHARGEABLE', label: 'Chargeable' },
  { value: 'GOODWILL', label: 'Goodwill' },
];

const BASIS_TONES: Record<string, Tone> = {
  WARRANTY: 'ok',
  CONTRACT: 'info',
  CHARGEABLE: 'warn',
  GOODWILL: '',
};

const STATUSES = [
  { value: 'DRAFT', label: 'Draft' },
  { value: 'PENDING_APPROVAL', label: 'Pending approval' },
  { value: 'APPROVED', label: 'Approved — scheduled' },
  { value: 'COMPLETED', label: 'Completed' },
  { value: 'REJECTED', label: 'Returned' },
  { value: 'CANCELLED', label: 'Cancelled' },
];

/** REJECTED reads "Returned": the order goes back to whoever raised it. */
const JOB_ORDER_TONES: Record<string, Tone> = { REJECTED: 'warn' };
const statusLabel = (s: string) => (s === 'REJECTED' ? 'Returned' : undefined);

export function BasisBadge({ basis }: { basis: string }) {
  return <StatusBadge status={basis} extra={BASIS_TONES} label={basis.toLowerCase()} />;
}

interface Coverage {
  underWarranty: boolean;
  warrantyEndsAt: string | null;
  contract: { id: string; number: string; jobId: string; endsAt: string } | null;
  installingJob: { id: string; number: string; name: string } | null;
  suggested: string;
}

export interface JobOrderRow {
  id: string;
  number: string;
  status: string;
  kind: string;
  urgent: boolean;
  title: string;
  description: string;
  scope: string | null;
  requestedFor: string;
  chargeBasis: string;
  underWarranty: boolean;
  billable: boolean;
  amount: number | null;
  customerPoNumber: string | null;
  customerAcknowledgedBy: string | null;
  customerAcknowledgedAt: string | null;
  approvedAt: string | null;
  completedAt: string | null;
  cancelledAt: string | null;
  cancelReason: string | null;
  notes: string | null;
  createdAt: string;
  customer: { id: string; code: string; name: string };
  site: { id: string; name: string; city: string | null } | null;
  contact: { id: string; name: string; phone: string | null } | null;
  asset: {
    id: string;
    code: string;
    name: string;
    model: string | null;
    serialNo: string | null;
    warrantyEndsAt: string | null;
  } | null;
  contract: { id: string; number: string; endsAt: string } | null;
  job: { id: string; number: string; name: string } | null;
  quotation: { id: string; number: string; subject: string } | null;
  requestedBy: { id: string; name: string; position: string | null };
  assignedTo: { id: string; name: string } | null;
  visit: {
    id: string;
    number: string;
    status: string;
    dueDate: string;
    report: { id: string; number: string; status: string } | null;
  } | null;
  invoice: { id: string; number: string; status: string } | null;
}

interface JobOrderDetailRow extends JobOrderRow {
  coverage: Coverage | null;
  canEdit: boolean;
  canCancel: boolean;
  canAcknowledge: boolean;
}

// ── The list ────────────────────────────────────────────────────────────────

export function JobOrders() {
  const { can } = useAuth();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  // `?new=1&customerId=&assetId=&quotationId=&siteId=&kind=` — how Customer
  // 360, a machine's page and a won quotation start one without retyping.
  const [raising, setRaising] = useState(() => params.get('new') === '1' && can('gops.job_orders.create'));
  const [prefill] = useState(() => ({
    customerId: params.get('customerId') ?? undefined,
    siteId: params.get('siteId') ?? undefined,
    assetId: params.get('assetId') ?? undefined,
    quotationId: params.get('quotationId') ?? undefined,
    kind: params.get('kind') ?? undefined,
  }));

  function closeRaising() {
    setRaising(false);
    if (params.has('new')) {
      const next = new URLSearchParams(params);
      for (const k of ['new', 'customerId', 'siteId', 'assetId', 'quotationId', 'kind']) next.delete(k);
      setParams(next, { replace: true });
    }
  }

  const columns: Column<JobOrderRow>[] = [
    {
      key: 'number',
      label: 'Number',
      sortKey: 'number',
      render: (r) => (
        <div>
          <span className="mono">{r.number}</span>
          {r.urgent && (
            <div>
              <span className="badge danger">urgent</span>
            </div>
          )}
        </div>
      ),
    },
    {
      key: 'title',
      label: 'Job',
      render: (r) => (
        <div>
          <div>{r.title}</div>
          <div className="faint">{KIND_LABEL[r.kind] ?? r.kind}</div>
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
      key: 'requestedFor',
      label: 'Wanted',
      sortKey: 'requestedFor',
      render: (r) => (
        <div>
          <div>{formatDate(r.requestedFor)}</div>
          <div className="faint">{r.requestedBy.name}</div>
        </div>
      ),
    },
    {
      key: 'cover',
      label: 'Covered by',
      render: (r) => (
        <div>
          <BasisBadge basis={r.chargeBasis} />
          {r.chargeBasis === 'CHARGEABLE' && r.amount != null && (
            <div className="faint mono">{formatMoney(r.amount)}</div>
          )}
        </div>
      ),
    },
    {
      key: 'assignedTo',
      label: 'Engineer',
      render: (r) => (r.assignedTo ? r.assignedTo.name : <span className="badge warn">unassigned</span>),
    },
    {
      key: 'visit',
      label: 'Visit / report',
      render: (r) =>
        r.visit?.report ? (
          <Link to={`/g-ops/service-reports/${r.visit.report.id}`} className="mono">
            {r.visit.report.number}
          </Link>
        ) : r.visit ? (
          <div>
            <Link to={`/g-ops/visits?visit=${r.visit.id}`} className="mono">
              {r.visit.number}
            </Link>
            <div>
              <VisitBadge visit={{ status: r.visit.status, overdue: false }} />
            </div>
          </div>
        ) : (
          <span className="faint">—</span>
        ),
    },
    {
      key: 'status',
      label: 'Status',
      render: (r) => <StatusBadge status={r.status} extra={JOB_ORDER_TONES} label={statusLabel(r.status)} />,
    },
  ];

  const canCreate = can('gops.job_orders.create');

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Job Orders</h1>
          <p>
            A request for service work — a breakdown call, an installation, a paid PM outside contract
            or warranty work. Approved by the service manager, it becomes a visit on the Service
            Schedule; the engineer’s approved report completes it.
          </p>
        </div>
      </div>

      <DataList<JobOrderRow>
        listKey="job-orders"
        endpoint="/job-orders"
        columns={columns}
        rowKey={(r) => r.id}
        scoped
        onRowClick={(r) => navigate(`/g-ops/job-orders/${r.id}`)}
        searchPlaceholder="Search number, title, customer, serial…"
        emptyTitle="No job orders yet"
        emptyHint="Raise one from a customer, a machine in the installed base, or a won quotation."
        filters={[
          { key: 'status', label: 'Status', options: STATUSES },
          { key: 'kind', label: 'Kind', options: KINDS },
          { key: 'chargeBasis', label: 'Cover', options: CHARGE_BASES },
          {
            key: 'open',
            label: 'Open',
            options: [{ value: 'true', label: 'Scheduled, not yet reported' }],
          },
          {
            key: 'unbilled',
            label: 'Billing',
            options: [{ value: 'true', label: 'Completed, chargeable, not invoiced' }],
          },
        ]}
        actions={
          canCreate ? (
            <button type="button" className="btn btn-primary btn-sm" onClick={() => setRaising(true)}>
              + New job order
            </button>
          ) : null
        }
      />

      {raising && (
        <JobOrderModal
          prefill={prefill}
          onClose={closeRaising}
          onSaved={(id) => {
            setRaising(false);
            navigate(`/g-ops/job-orders/${id}`);
          }}
        />
      )}
    </div>
  );
}

// ── Raising and editing ─────────────────────────────────────────────────────

interface Options {
  sites: { id: string; name: string; city: string | null }[];
  contacts: { id: string; name: string; phone: string | null }[];
  assets: { id: string; code: string; name: string; serialNo: string | null; siteId: string | null }[];
  quotations: { id: string; number: string; subject: string; outcome: string }[];
  jobs: { id: string; number: string; name: string; type: string; status: string }[];
}

const NO_OPTIONS: Options = { sites: [], contacts: [], assets: [], quotations: [], jobs: [] };

function coverageAlert(c: Coverage | null, date: string) {
  if (!c) return null;
  if (c.contract) {
    return (
      <div className="alert info">
        Covered by contract <span className="mono">{c.contract.number}</span> on {formatDate(date)} — no
        charge. The work is charged to the contract’s job.
      </div>
    );
  }
  if (c.underWarranty) {
    return (
      <div className="alert ok">
        Under warranty until {formatDate(c.warrantyEndsAt)} — no charge. The work is charged to the
        project that installed it{c.installingJob ? ` (${c.installingJob.number})` : ''}.
      </div>
    );
  }
  return (
    <div className="alert warn">
      Out of warranty and not under contract on {formatDate(date)} — this call is chargeable.
    </div>
  );
}

export function JobOrderModal({
  prefill,
  existing,
  onClose,
  onSaved,
}: {
  prefill?: { customerId?: string; siteId?: string; assetId?: string; quotationId?: string; kind?: string };
  existing?: JobOrderRow;
  onClose: () => void;
  onSaved: (id: string) => void;
}) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [customers, setCustomers] = useState<{ id: string; name: string }[]>([]);
  const [options, setOptions] = useState<Options>(NO_OPTIONS);
  const [engineers, setEngineers] = useState<{ id: string; name: string; position: string | null }[]>([]);
  const [coverage, setCoverage] = useState<Coverage | null>(null);
  // Once somebody picks a basis by hand, a new coverage answer must not
  // overwrite it — the override is the point of the field.
  const basisTouched = useRef(!!existing);

  const [form, setForm] = useState(() => ({
    customerId: existing?.customer.id ?? prefill?.customerId ?? '',
    siteId: existing?.site?.id ?? prefill?.siteId ?? '',
    contactId: existing?.contact?.id ?? '',
    assetId: existing?.asset?.id ?? prefill?.assetId ?? '',
    kind: existing?.kind ?? (prefill?.kind && KIND_LABEL[prefill.kind] ? prefill.kind : 'CORRECTIVE'),
    urgent: existing?.urgent ?? false,
    title: existing?.title ?? '',
    description: existing?.description ?? '',
    scope: existing?.scope ?? '',
    requestedFor: existing?.requestedFor.slice(0, 10) ?? todayLocal(),
    assignedToId: existing?.assignedTo?.id ?? '',
    chargeBasis: existing?.chargeBasis ?? 'CHARGEABLE',
    quotationId: existing?.quotation?.id ?? prefill?.quotationId ?? '',
    customerPoNumber: existing?.customerPoNumber ?? '',
    amount: existing?.amount != null ? String(existing.amount) : '',
    jobId: existing?.job?.id ?? '',
  }));

  useEffect(() => {
    api
      .get<{ customers: { id: string; name: string }[] }>('/job-orders/options')
      .then((d) => setCustomers(d.customers))
      .catch(() => setCustomers([]));
    api
      .get<{ id: string; name: string; position: string | null }[]>(
        `/users/lookup${qs({ holding: 'gops.pm_reports.create' })}`,
      )
      .then(setEngineers)
      .catch(() => setEngineers([]));
  }, []);

  useEffect(() => {
    if (!form.customerId) {
      setOptions(NO_OPTIONS);
      return;
    }
    api
      .get<Options>(`/job-orders/options${qs({ customerId: form.customerId })}`)
      .then(setOptions)
      .catch(() => setOptions(NO_OPTIONS));
  }, [form.customerId]);

  useEffect(() => {
    if (!form.requestedFor) return;
    let live = true;
    api
      .get<Coverage>(`/job-orders/coverage${qs({ assetId: form.assetId || undefined, date: form.requestedFor })}`)
      .then((c) => {
        if (!live) return;
        setCoverage(c);
        if (!basisTouched.current) setForm((f) => ({ ...f, chargeBasis: c.suggested }));
      })
      .catch(() => live && setCoverage(null));
    return () => {
      live = false;
    };
  }, [form.assetId, form.requestedFor]);

  async function save() {
    setBusy(true);
    setError(null);
    const body = {
      siteId: form.siteId || null,
      contactId: form.contactId || null,
      assetId: form.assetId || null,
      kind: form.kind,
      urgent: form.urgent,
      title: form.title,
      description: form.description,
      scope: form.scope || null,
      requestedFor: form.requestedFor,
      assignedToId: form.assignedToId || null,
      chargeBasis: form.chargeBasis,
      quotationId: form.chargeBasis === 'CHARGEABLE' ? form.quotationId || null : null,
      customerPoNumber: form.customerPoNumber || null,
      amount: form.chargeBasis === 'CHARGEABLE' && form.amount !== '' ? Number(form.amount) : null,
      jobId: form.jobId || null,
    };
    try {
      if (existing) {
        await api.patch(`/job-orders/${existing.id}`, body);
        toast('ok', 'Job order updated');
        onSaved(existing.id);
      } else {
        const created = await api.post<{ id: string; number: string }>('/job-orders', {
          customerId: form.customerId,
          ...body,
        });
        toast('ok', `${created.number} raised — submit it when ready`);
        onSaved(created.id);
      }
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  }

  const chosenAsset = options.assets.find((a) => a.id === form.assetId);
  const sellsWork = form.chargeBasis === 'CHARGEABLE';
  const pickJob = form.chargeBasis === 'CHARGEABLE' || form.chargeBasis === 'GOODWILL';

  return (
    <Modal
      title={existing ? `Modify ${existing.number}` : 'New job order'}
      onClose={onClose}
      wide
      footer={
        <>
          <button type="button" className="btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-primary"
            onClick={save}
            disabled={
              busy ||
              !form.customerId ||
              form.title.trim().length < 3 ||
              form.description.trim().length < 5 ||
              !form.requestedFor
            }
          >
            {busy ? 'Saving…' : existing ? 'Save' : 'Raise job order'}
          </button>
        </>
      }
    >
      <ErrorBox error={error} />

      <div className="grid grid-2">
        <Field label="Customer">
          <select
            value={form.customerId}
            disabled={!!existing || !!prefill?.customerId}
            onChange={(e) =>
              setForm({ ...form, customerId: e.target.value, siteId: '', contactId: '', assetId: '', quotationId: '', jobId: '' })
            }
          >
            <option value="">— choose —</option>
            {existing && !customers.some((c) => c.id === existing.customer.id) && (
              <option value={existing.customer.id}>{existing.customer.name}</option>
            )}
            {customers.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Equipment" hint="Leave empty for work on nothing registered yet — an installation, say">
          <select
            value={form.assetId}
            onChange={(e) => {
              const a = options.assets.find((x) => x.id === e.target.value);
              setForm({ ...form, assetId: e.target.value, siteId: a?.siteId ?? form.siteId });
            }}
          >
            <option value="">— none —</option>
            {options.assets.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
                {a.serialNo ? ` (${a.serialNo})` : ''}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Site">
          <select value={form.siteId} onChange={(e) => setForm({ ...form, siteId: e.target.value })}>
            <option value="">— none —</option>
            {options.sites.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
                {s.city ? ` · ${s.city}` : ''}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Contact on site">
          <select value={form.contactId} onChange={(e) => setForm({ ...form, contactId: e.target.value })}>
            <option value="">— none —</option>
            {options.contacts.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
                {c.phone ? ` · ${c.phone}` : ''}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Kind of work">
          <select value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value })}>
            {KINDS.map((k) => (
              <option key={k.value} value={k.value}>
                {k.label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Wanted on">
          <input
            type="date"
            value={form.requestedFor}
            onChange={(e) => setForm({ ...form, requestedFor: e.target.value })}
          />
        </Field>
      </div>

      <Checkbox checked={form.urgent} onChange={(v) => setForm({ ...form, urgent: v })} label="Urgent — equipment down" />

      <Field label="In one line">
        <input
          value={form.title}
          placeholder="Compressor tripping on high temperature"
          onChange={(e) => setForm({ ...form, title: e.target.value })}
        />
      </Field>
      <Field label="What the customer reported or asked for">
        <textarea rows={3} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
      </Field>
      <Field label="What we will do" hint="Optional — the report records what was actually done">
        <textarea rows={2} value={form.scope} onChange={(e) => setForm({ ...form, scope: e.target.value })} />
      </Field>
      <Field label="Engineer to send" hint="Proposed — the service manager can change it on the schedule">
        <select value={form.assignedToId} onChange={(e) => setForm({ ...form, assignedToId: e.target.value })}>
          <option value="">— leave to the service manager —</option>
          {existing?.assignedTo && !engineers.some((u) => u.id === existing.assignedTo!.id) && (
            <option value={existing.assignedTo.id}>{existing.assignedTo.name}</option>
          )}
          {engineers.map((u) => (
            <option key={u.id} value={u.id}>
              {u.name}
              {u.position ? ` — ${u.position}` : ''}
            </option>
          ))}
        </select>
      </Field>

      <h4 className="svc-subhead">Cover and charging</h4>
      {form.assetId ? (
        coverageAlert(coverage, form.requestedFor)
      ) : (
        <div className="alert info">
          No machine named, so nothing can cover it — chargeable unless you decide otherwise.
        </div>
      )}
      <div className="grid grid-2">
        <Field label="Charge basis" hint="Change this only if you know why — the service manager checks it">
          <select
            value={form.chargeBasis}
            onChange={(e) => {
              basisTouched.current = true;
              setForm({ ...form, chargeBasis: e.target.value });
            }}
          >
            {CHARGE_BASES.map((b) => (
              <option key={b.value} value={b.value} disabled={b.value === 'CONTRACT' && !coverage?.contract}>
                {b.label}
                {b.value === coverage?.suggested ? ' (from the records)' : ''}
              </option>
            ))}
          </select>
        </Field>
        {pickJob && (
          <Field label="Charge to project" hint="Optional — the job whose budget this work spends">
            <select value={form.jobId} onChange={(e) => setForm({ ...form, jobId: e.target.value })}>
              <option value="">— none —</option>
              {options.jobs.map((j) => (
                <option key={j.id} value={j.id}>
                  {j.number} — {j.name}
                </option>
              ))}
            </select>
          </Field>
        )}
      </div>
      {sellsWork && (
        <div className="grid grid-3">
          <Field label="Quotation">
            <select value={form.quotationId} onChange={(e) => setForm({ ...form, quotationId: e.target.value })}>
              <option value="">— none —</option>
              {options.quotations.map((q) => (
                <option key={q.id} value={q.id}>
                  {q.number} — {q.subject}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Customer PO">
            <input
              value={form.customerPoNumber}
              onChange={(e) => setForm({ ...form, customerPoNumber: e.target.value })}
            />
          </Field>
          <Field
            label="Agreed amount (before VAT)"
            hint={form.quotationId ? 'Empty takes the quotation’s price' : 'Leave empty to bill on completion'}
          >
            <NumberInput
              kind="money"
              min={0}
              step="0.01"
              value={form.amount}
              onChange={(e) => setForm({ ...form, amount: e.target.value })}
            />
          </Field>
        </div>
      )}
      {chosenAsset && coverage?.underWarranty && form.chargeBasis === 'CHARGEABLE' && (
        <p className="faint">
          The machine is inside its warranty on that date. Charging for it is a decision the order will
          record, and the service manager will see it.
        </p>
      )}
    </Modal>
  );
}

// ── One job order ───────────────────────────────────────────────────────────

export function JobOrderDetail() {
  const { id } = useParams<{ id: string }>();
  const { can } = useAuth();
  const navigate = useNavigate();
  const toast = useToast();
  const [row, setRow] = useState<JobOrderDetailRow | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [reload, setReload] = useState(0);
  const [modal, setModal] = useState<'edit' | 'cancel' | 'ack' | 'invoice' | 'report' | null>(null);

  const load = useCallback(async () => {
    if (!id) return;
    try {
      setRow(await api.get<JobOrderDetailRow>(`/job-orders/${id}`));
      setReload((n) => n + 1);
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

  if (loading) return <Loading />;
  if (!row) return <ErrorBox error={error ?? new Error('Job order not found')} />;

  async function run(label: string, fn: () => Promise<unknown>) {
    setBusy(true);
    try {
      await fn();
      toast('ok', label);
      await load();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  const r = row;
  const canWriteReport =
    r.status === 'APPROVED' && !!r.visit && !r.visit.report && can(reportPermission(r.kind, 'create'));
  const canInvoice = r.status === 'COMPLETED' && r.billable && !r.invoice && can('gfin.ar.create');

  return (
    <div>
      <div className="breadcrumb">
        <Link to="/g-ops/job-orders">Job Orders</Link>
        <span className="sep">›</span>
        <span className="mono">{r.number}</span>
      </div>

      <RecordHeader
        type="Job Order"
        code={r.number}
        title={r.title}
        status={r.status}
        statusExtra={JOB_ORDER_TONES}
        amount={r.billable && r.amount != null ? formatMoney(r.amount) : undefined}
        amountLabel="Agreed amount"
        actions={
          <>
            <button
              type="button"
              className="btn"
              onClick={() => openPdf(`/api/job-orders/${r.id}/pdf`, () => toast('error', 'Could not print'))}
            >
              Print
            </button>
            {r.canEdit && (
              <button type="button" className="btn" onClick={() => setModal('edit')} disabled={busy}>
                Modify
              </button>
            )}
            {r.canEdit && (
              <button
                type="button"
                className="btn btn-ok"
                disabled={busy}
                onClick={() => run('Sent to the service manager', () => api.post(`/job-orders/${r.id}/submit`))}
              >
                {r.status === 'REJECTED' ? 'Submit again' : 'Submit for approval'}
              </button>
            )}
            {canWriteReport && (
              <button type="button" className="btn" onClick={() => setModal('report')} disabled={busy}>
                Write report
              </button>
            )}
            {r.canAcknowledge && (
              <button type="button" className="btn" onClick={() => setModal('ack')} disabled={busy}>
                {r.customerAcknowledgedBy ? 'Re-record acknowledgement' : 'Record acknowledgement'}
              </button>
            )}
            {canInvoice && (
              <button type="button" className="btn btn-primary" onClick={() => setModal('invoice')} disabled={busy}>
                Raise invoice
              </button>
            )}
            {r.canCancel && (
              <button type="button" className="btn btn-danger" onClick={() => setModal('cancel')} disabled={busy}>
                Cancel
              </button>
            )}
          </>
        }
      />

      <p className="record-head-meta">
        Raised by {r.requestedBy.name} on {formatDate(r.createdAt)}
        {r.approvedAt ? ` · accepted ${formatDate(r.approvedAt)}` : ''}
        {r.completedAt ? ` · completed ${formatDate(r.completedAt)}` : ''}
        {r.urgent ? ' · URGENT' : ''}
      </p>

      <DocumentApproval documentType="job_order" documentId={r.id} reloadToken={reload} />

      <ErrorBox error={error} />

      {r.status === 'DRAFT' && (
        <div className="alert info">
          Nothing is dispatched until the service manager accepts it — approval books the visit.
        </div>
      )}
      {r.status === 'PENDING_APPROVAL' && (
        <div className="alert info">
          With the service manager, who checks the cover and who to send. To change it, ask them to
          return it.
        </div>
      )}
      {r.status === 'REJECTED' && (
        <div className="alert warn">Returned. Correct what the approver asked for, then submit it again.</div>
      )}
      {r.status === 'CANCELLED' && (
        <div className="alert warn">
          Cancelled{r.cancelledAt ? ` on ${formatDate(r.cancelledAt)}` : ''}: {r.cancelReason ?? 'no reason recorded'}
        </div>
      )}
      {r.status === 'COMPLETED' && r.billable && !r.invoice && (
        <div className="alert warn">
          Done and reported, and chargeable — not yet invoiced.
          {!can('gfin.ar.create') && ' Finance raises the invoice from this page.'}
        </div>
      )}

      <div className="svc-detail-grid">
        <section className="card">
          <h3 className="card-title">Request</h3>
          <dl className="kv">
            <dt>Kind</dt>
            <dd>{KIND_LABEL[r.kind]}</dd>
            <dt>Priority</dt>
            <dd>{r.urgent ? <span className="badge danger">urgent</span> : 'routine'}</dd>
            <dt>Wanted on</dt>
            <dd>{formatDate(r.requestedFor)}</dd>
            <dt>Customer</dt>
            <dd>
              {can('gops.customers.view_all') ? (
                <Link to={`/g-ops/customers/${r.customer.id}`}>{r.customer.name}</Link>
              ) : (
                r.customer.name
              )}
            </dd>
            <dt>Site</dt>
            <dd>{r.site ? `${r.site.name}${r.site.city ? ` · ${r.site.city}` : ''}` : '—'}</dd>
            <dt>Contact</dt>
            <dd>{r.contact ? [r.contact.name, r.contact.phone].filter(Boolean).join(' · ') : '—'}</dd>
            <dt>Equipment</dt>
            <dd>
              {r.asset ? (
                <>
                  {can('gops.installed_base.view_all') ? (
                    <Link to={`/g-ops/installed-base/${r.asset.id}`}>{r.asset.name}</Link>
                  ) : (
                    r.asset.name
                  )}
                  {r.asset.serialNo && <span className="faint mono"> · {r.asset.serialNo}</span>}
                  {r.asset.warrantyEndsAt && (
                    <div className="faint">warranty to {formatDate(r.asset.warrantyEndsAt)}</div>
                  )}
                </>
              ) : (
                <span className="faint">none named</span>
              )}
            </dd>
          </dl>
        </section>

        <section className="card">
          <h3 className="card-title">Cover and charging</h3>
          <dl className="kv">
            <dt>Basis</dt>
            <dd>
              <BasisBadge basis={r.chargeBasis} />
            </dd>
            <dt>Under warranty that day</dt>
            <dd>{r.underWarranty ? 'yes' : 'no'}</dd>
            {r.contract && (
              <>
                <dt>Contract</dt>
                <dd>
                  <Link to={`/g-ops/service-contracts/${r.contract.id}`} className="mono">
                    {r.contract.number}
                  </Link>{' '}
                  <span className="faint">to {formatDate(r.contract.endsAt)}</span>
                </dd>
              </>
            )}
            <dt>Charged to</dt>
            <dd>
              {r.job ? (
                <Link to={`/g-ops/projects/${r.job.id}`} className="mono">
                  {r.job.number}
                </Link>
              ) : (
                <span className="faint">no project</span>
              )}
              {r.job && <span className="faint"> {r.job.name}</span>}
            </dd>
            {r.billable && (
              <>
                <dt>Quotation</dt>
                <dd>
                  {r.quotation ? (
                    <Link to={`/g-ops/quotations/${r.quotation.id}`} className="mono">
                      {r.quotation.number}
                    </Link>
                  ) : (
                    '—'
                  )}
                </dd>
                <dt>Customer PO</dt>
                <dd>{r.customerPoNumber ?? '—'}</dd>
                <dt>Amount</dt>
                <dd className="mono">{r.amount != null ? formatMoney(r.amount) : 'to be billed on completion'}</dd>
                <dt>Invoice</dt>
                <dd>
                  {r.invoice ? (
                    <>
                      <Link to={`/g-fin/ar/${r.invoice.id}`} className="mono">
                        {r.invoice.number}
                      </Link>{' '}
                      <StatusBadge status={r.invoice.status} />
                    </>
                  ) : (
                    <span className="faint">not yet</span>
                  )}
                </dd>
              </>
            )}
            {r.customerAcknowledgedBy && (
              <>
                <dt>Acknowledged by</dt>
                <dd>
                  {r.customerAcknowledgedBy}
                  {r.customerAcknowledgedAt && (
                    <span className="faint"> on {formatDate(r.customerAcknowledgedAt)}</span>
                  )}
                </dd>
              </>
            )}
          </dl>
        </section>
      </div>

      <section className="card">
        <h3 className="card-title">Reported problem</h3>
        <p className="svc-text">{r.description}</p>
        {r.scope && (
          <>
            <h4 className="svc-subhead">Scope of work</h4>
            <p className="svc-text">{r.scope}</p>
          </>
        )}
      </section>

      <section className="card">
        <h3 className="card-title">Dispatch</h3>
        {r.visit ? (
          <dl className="kv">
            <dt>Engineer</dt>
            <dd>{r.assignedTo?.name ?? <span className="faint">unassigned</span>}</dd>
            <dt>Visit</dt>
            <dd>
              <Link to={`/g-ops/visits?visit=${r.visit.id}`} className="mono">
                {r.visit.number}
              </Link>{' '}
              <VisitBadge visit={{ status: r.visit.status, overdue: false }} />{' '}
              <span className="faint">due {formatDate(r.visit.dueDate)}</span>
            </dd>
            <dt>Report</dt>
            <dd>
              {r.visit.report ? (
                <>
                  <Link to={`/g-ops/service-reports/${r.visit.report.id}`} className="mono">
                    {r.visit.report.number}
                  </Link>{' '}
                  <StatusBadge status={r.visit.report.status} />
                </>
              ) : (
                <span className="faint">not written yet</span>
              )}
            </dd>
          </dl>
        ) : (
          <p className="muted">
            Nothing dispatched yet — approval schedules the visit
            {r.assignedTo ? `, proposed for ${r.assignedTo.name}` : ''}.
          </p>
        )}
      </section>

      <Attachments
        entityType="job_order"
        entityId={r.id}
        title="Photos and documents"
        hint="The customer’s email, a photo of the fault, the PO"
        canEdit={r.canEdit || r.status !== 'CANCELLED'}
      />

      {modal === 'edit' && (
        <JobOrderModal
          existing={r}
          onClose={() => setModal(null)}
          onSaved={() => {
            setModal(null);
            void load();
          }}
        />
      )}
      {modal === 'cancel' && (
        <ReasonModal
          title={`Cancel ${r.number}`}
          label="Why is it cancelled?"
          hint={
            r.visit?.status === 'SCHEDULED'
              ? `Its visit ${r.visit.number} is cancelled with it${r.assignedTo ? `, and ${r.assignedTo.name} is told` : ''}.`
              : undefined
          }
          action="Cancel job order"
          danger
          onClose={() => setModal(null)}
          onSubmit={(reason) =>
            run('Job order cancelled', () => api.post(`/job-orders/${r.id}/cancel`, { reason })).then(() => setModal(null))
          }
        />
      )}
      {modal === 'ack' && (
        <ReasonModal
          title="Customer acknowledgement"
          label="Who signed for it?"
          hint="The name printed in the customer’s slot on the job order"
          initial={r.customerAcknowledgedBy ?? r.contact?.name ?? ''}
          action="Record"
          onClose={() => setModal(null)}
          onSubmit={(name) =>
            run('Acknowledgement recorded', () =>
              api.patch(`/job-orders/${r.id}/acknowledge`, { customerAcknowledgedBy: name }),
            ).then(() => setModal(null))
          }
        />
      )}
      {modal === 'invoice' && (
        <InvoiceModal
          order={r}
          onClose={() => setModal(null)}
          onRaised={(invoiceId) => {
            setModal(null);
            navigate(`/g-fin/ar/${invoiceId}`);
          }}
        />
      )}
      {modal === 'report' && r.visit && (
        <NewReportModal
          preset={{ visitId: r.visit.id }}
          onClose={() => setModal(null)}
          onCreated={(reportId) => navigate(`/g-ops/service-reports/${reportId}`)}
        />
      )}
    </div>
  );
}

function ReasonModal({
  title,
  label,
  hint,
  initial = '',
  action,
  danger,
  onClose,
  onSubmit,
}: {
  title: string;
  label: string;
  hint?: string;
  initial?: string;
  action: string;
  danger?: boolean;
  onClose: () => void;
  onSubmit: (value: string) => Promise<unknown>;
}) {
  const [value, setValue] = useState(initial);
  const [busy, setBusy] = useState(false);
  return (
    <Modal
      title={title}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose} disabled={busy}>
            Back
          </button>
          <button
            type="button"
            className={`btn ${danger ? 'btn-danger' : 'btn-primary'}`}
            disabled={busy || value.trim().length < 2}
            onClick={() => {
              setBusy(true);
              void onSubmit(value.trim()).finally(() => setBusy(false));
            }}
          >
            {action}
          </button>
        </>
      }
    >
      <Field label={label} hint={hint}>
        <input value={value} onChange={(e) => setValue(e.target.value)} autoFocus />
      </Field>
    </Modal>
  );
}

/**
 * Billing a completed chargeable order — through the ONE invoice path,
 * `POST /invoices` with the order's id, which refuses warranty and contract
 * work, an order whose report is not approved, and a second invoice.
 */
function InvoiceModal({
  order,
  onClose,
  onRaised,
}: {
  order: JobOrderRow;
  onClose: () => void;
  onRaised: (invoiceId: string) => void;
}) {
  const toast = useToast();
  const [amount, setAmount] = useState(order.amount != null ? String(order.amount) : '');
  const [dueDate, setDueDate] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  async function raise() {
    setBusy(true);
    setError(null);
    try {
      const invoice = await api.post<{ id: string; number: string }>('/invoices', {
        jobOrderId: order.id,
        customerId: order.customer.id,
        jobId: order.job?.id ?? null,
        poReference: order.customerPoNumber,
        ...(dueDate ? { dueDate } : {}),
        lines: [{ description: `${order.number} — ${order.title}`, amount: Number(amount) }],
      });
      toast('ok', `${invoice.number} raised`);
      onRaised(invoice.id);
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  }

  return (
    <Modal
      title={`Invoice ${order.number}`}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-primary"
            onClick={raise}
            disabled={busy || !(Number(amount) > 0)}
          >
            {busy ? 'Raising…' : 'Raise invoice'}
          </button>
        </>
      }
    >
      <ErrorBox error={error} />
      <p className="muted">
        One line, “{order.number} — {order.title}”, to {order.customer.name}. VAT is added and EWT
        withheld at the rates in Settings, as on every invoice.
      </p>
      <div className="grid grid-2">
        <Field
          label="Amount (before VAT)"
          hint={order.amount != null ? 'The agreed price' : 'Time and materials — type what was agreed'}
        >
          <NumberInput kind="money" min={0} step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} />
        </Field>
        <Field label="Due date" hint="Empty uses the default payment terms">
          <input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
        </Field>
      </div>
    </Modal>
  );
}
