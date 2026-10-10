import { useCallback, useEffect, useId, useMemo, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api, qs } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { DataList, type Column } from '../../components/DataList';
import { RecordHeader } from '../../components/RecordHeader';
import { useConfirm } from '../../components/Confirm';
import { DocumentApproval } from '../../components/ApprovalStepper';
import { Attachments } from '../../components/Attachments';
import { PeoplePicker } from '../../components/PeoplePicker';
import { PersonSelect, toPerson, usePeople } from '../../components/People';
import { CustomerPicker, type CustomerRef } from '../../components/CustomerPicker';
import {
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
import { parseDay, todayLocal } from '../../lib/day';
import { NewReportModal, reportPermission } from './Reports';
import { VisitBadge } from './Schedule';
import { NumberInput } from '../../components/NumberInput';

/**
 * Job orders — the PROJECT WORK ORDER (2026-10-09, the owner's call; a
 * request for service work before that).
 *
 * Sales raises it for a customer, linked to the quotation (any open one —
 * one under negotiation included), the sales order and/or the project; it
 * names the project, the contact and their number, the target start and
 * finish (the working days between them computed as they are typed), the
 * scope of work in one box, the amount, and the people to send: project
 * manager, project engineer, project lead, project support.
 *
 * The route is the project manager named on the order, then the
 * salesperson's team leader; approval BUILDS THE PROJECT from the costing
 * behind the linked quotation, with the targets as its dates.
 */

const BASIS_TONES: Record<string, Tone> = {
  WARRANTY: 'ok',
  CONTRACT: 'info',
  CHARGEABLE: 'warn',
  GOODWILL: '',
};

const STATUSES = [
  { value: 'DRAFT', label: 'Draft' },
  { value: 'PENDING_APPROVAL', label: 'Pending approval' },
  { value: 'APPROVED', label: 'Approved' },
  { value: 'COMPLETED', label: 'Completed' },
  { value: 'REJECTED', label: 'Returned' },
  { value: 'CANCELLED', label: 'Cancelled' },
];

/** REJECTED reads "Returned": the order goes back to whoever raised it. */
const JOB_ORDER_TONES: Record<string, Tone> = { REJECTED: 'warn' };
const statusLabel = (s: string) => (s === 'REJECTED' ? 'Returned' : undefined);

/** Orders raised as service calls before 2026-10-09 still carry a charge basis; the installed base shows it. */
export function BasisBadge({ basis }: { basis: string }) {
  return <StatusBadge status={basis} extra={BASIS_TONES} label={basis.toLowerCase()} />;
}

interface Person {
  id: string;
  name: string;
  position: string | null;
}

export interface JobOrderRow {
  id: string;
  number: string;
  status: string;
  kind: string;
  title: string;
  projectName: string | null;
  contactNumber: string | null;
  description: string;
  scope: string | null;
  targetStart: string;
  targetFinish: string;
  durationDays: number;
  requestedFor: string;
  chargeBasis: string;
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
  job: { id: string; number: string; name: string; status: string } | null;
  quotation: { id: string; number: string; subject: string; outcome: string } | null;
  salesOrder: { id: string; number: string; status: string } | null;
  requestedBy: Person;
  assignedTo: { id: string; name: string } | null;
  projectManager: Person | null;
  projectEngineer: Person | null;
  projectLead: Person | null;
  support: Person[];
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
  canEdit: boolean;
  canCancel: boolean;
  canAcknowledge: boolean;
  route: { step: string; names: string[] }[];
}

/** Working days (Mon–Fri) from one day to another, both counted; the API's `workingDaysBetween`. */
function workingDays(from: string, to: string): number {
  if (!from || !to) return 0;
  const d = parseDay(from);
  const end = parseDay(to).getTime();
  let days = 0;
  while (d.getTime() <= end) {
    const dow = d.getDay();
    if (dow !== 0 && dow !== 6) days++;
    d.setDate(d.getDate() + 1);
  }
  return days;
}

const daysLabel = (n: number) => `${n} working day${n === 1 ? '' : 's'}`;

// ── The list ────────────────────────────────────────────────────────────────

export function JobOrders() {
  const { can } = useAuth();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  // `?new=1&customerId=&quotationId=&siteId=` — how Customer 360 and a
  // quotation start one without retyping. (`assetId`, from the installed
  // base's button, is read no more: an order names no machine.)
  const [raising, setRaising] = useState(() => params.get('new') === '1' && can('gops.job_orders.create'));
  const [prefill] = useState(() => ({
    customerId: params.get('customerId') ?? undefined,
    siteId: params.get('siteId') ?? undefined,
    quotationId: params.get('quotationId') ?? undefined,
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
    { key: 'number', label: 'Number', sortKey: 'number', width: '130px', render: (r) => <span className="mono">{r.number}</span> },
    {
      key: 'project',
      label: 'Project',
      render: (r) => (
        <div>
          <div>{r.projectName ?? r.title}</div>
          {r.projectName && <div className="faint">{r.title}</div>}
        </div>
      ),
    },
    {
      key: 'customer',
      label: 'Customer',
      render: (r) => (
        <div>
          <div>{r.customer.name}</div>
          <div className="faint">{r.site?.name ?? r.contact?.name ?? '—'}</div>
        </div>
      ),
    },
    {
      key: 'targets',
      label: 'Target',
      sortKey: 'requestedFor',
      render: (r) => (
        <div>
          <div>
            {formatDate(r.targetStart)} → {formatDate(r.targetFinish)}
          </div>
          <div className="faint">{daysLabel(r.durationDays)}</div>
        </div>
      ),
    },
    {
      key: 'amount',
      label: 'Amount',
      align: 'right',
      render: (r) => (r.amount != null ? <span className="mono">{formatMoney(r.amount)}</span> : <span className="faint">—</span>),
    },
    {
      key: 'people',
      label: 'Project manager',
      render: (r) => (
        <div>
          <div>{r.projectManager?.name ?? <span className="badge warn">none named</span>}</div>
          <div className="faint">{r.requestedBy.name}</div>
        </div>
      ),
    },
    {
      key: 'links',
      label: 'Links',
      render: (r) => (
        <div className="faint mono">
          {[r.quotation?.number, r.salesOrder?.number, r.job?.number].filter(Boolean).join(' · ') || '—'}
        </div>
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
        </div>
      </div>

      <DataList<JobOrderRow>
        listKey="job-orders"
        endpoint="/job-orders"
        columns={columns}
        rowKey={(r) => r.id}
        scoped
        onRowClick={(r) => navigate(`/g-ops/job-orders/${r.id}`)}
        searchPlaceholder="Search number, project, customer, quotation…"
        emptyTitle="No job orders yet"
        emptyHint="Raise one for a customer, linked to its quotation — approval builds the project."
        printPath="/api/job-orders/pdf"
        filters={[
          { key: 'status', label: 'Status', options: STATUSES },
          { key: 'open', label: 'Open', options: [{ value: 'true', label: 'Approved' }] },
          { key: 'from', toKey: 'to', label: 'Target start', type: 'dateRange' },
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
  quotations: {
    id: string;
    number: string;
    subject: string;
    outcome: string;
    contactId: string | null;
    siteId: string | null;
    amount: number | null;
    costed: boolean;
  }[];
  salesOrders: { id: string; number: string; status: string; quotationId: string; contactId: string | null; poNumber: string | null; amount: number }[];
  jobs: { id: string; number: string; name: string; type: string; status: string; projectManagerId: string | null }[];
}

const NO_OPTIONS: Options = { sites: [], contacts: [], quotations: [], salesOrders: [], jobs: [] };

const OUTCOME_LABEL: Record<string, string> = {
  OPEN: 'open',
  SUBMITTED: 'submitted',
  NEGOTIATION: 'under negotiation',
  WON: 'won',
  LOST: 'lost',
};

export function JobOrderModal({
  prefill,
  existing,
  onClose,
  onSaved,
}: {
  prefill?: { customerId?: string; siteId?: string; quotationId?: string };
  existing?: JobOrderRow;
  onClose: () => void;
  onSaved: (id: string) => void;
}) {
  const toast = useToast();
  const { can } = useAuth();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [customers, setCustomers] = useState<{ id: string; name: string }[]>([]);
  const [options, setOptions] = useState<Options>(NO_OPTIONS);
  const { people } = usePeople();
  const idBase = useId();
  // The customer is fixed once raised, and when the page that opened the form
  // named it; otherwise it is the one customer picker — for those who may read
  // the customer register it searches. Anybody else picks from the form's own
  // list (`/job-orders/options`, behind the job-order right), as before.
  const customerLocked = !!existing || !!prefill?.customerId;
  const searchCustomers = can('gops.customers.view_all');
  const [pickedCustomer, setPickedCustomer] = useState<CustomerRef | null>(null);

  const [form, setForm] = useState(() => ({
    customerId: existing?.customer.id ?? prefill?.customerId ?? '',
    quotationId: existing?.quotation?.id ?? prefill?.quotationId ?? '',
    salesOrderId: existing?.salesOrder?.id ?? '',
    jobId: existing?.job?.id ?? '',
    projectName: existing?.projectName ?? '',
    siteId: existing?.site?.id ?? prefill?.siteId ?? '',
    contactId: existing?.contact?.id ?? '',
    contactNumber: existing?.contactNumber ?? '',
    title: existing?.title ?? '',
    scope: existing?.scope ?? existing?.description ?? '',
    targetStart: existing?.targetStart.slice(0, 10) ?? todayLocal(),
    targetFinish: existing?.targetFinish.slice(0, 10) ?? todayLocal(),
    projectManagerId: existing?.projectManager?.id ?? '',
    projectEngineerId: existing?.projectEngineer?.id ?? '',
    projectLeadId: existing?.projectLead?.id ?? '',
    supportIds: existing?.support.map((p) => p.id) ?? [],
    customerPoNumber: existing?.customerPoNumber ?? '',
    amount: existing?.amount != null ? String(existing.amount) : '',
  }));
  const set = <K extends keyof typeof form>(k: K, v: (typeof form)[K]) => setForm((f) => ({ ...f, [k]: v }));

  useEffect(() => {
    api
      .get<{ customers: { id: string; name: string }[] }>('/job-orders/options')
      .then((d) => setCustomers(d.customers))
      .catch(() => setCustomers([]));
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

  // A prefilled quotation fills the form once its facts arrive.
  useEffect(() => {
    if (existing || !prefill?.quotationId || !options.quotations.length) return;
    const q = options.quotations.find((x) => x.id === prefill.quotationId);
    if (q) pickQuotation(q);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [options.quotations]);

  /** Linking a quotation fills what it knows: the project's name, the contact, the site, the amount. */
  function pickQuotation(q: Options['quotations'][number] | undefined) {
    setForm((f) => {
      if (!q) return { ...f, quotationId: '', salesOrderId: f.salesOrderId && options.salesOrders.find((o) => o.id === f.salesOrderId)?.quotationId === f.quotationId ? '' : f.salesOrderId };
      const contact = q.contactId ? options.contacts.find((c) => c.id === q.contactId) : undefined;
      return {
        ...f,
        quotationId: q.id,
        projectName: f.projectName || q.subject,
        contactId: f.contactId || q.contactId || '',
        contactNumber: f.contactNumber || contact?.phone || '',
        siteId: f.siteId || q.siteId || '',
        amount: f.amount || (q.amount != null ? String(q.amount) : ''),
        // A sales order on another quotation no longer fits.
        salesOrderId: f.salesOrderId && options.salesOrders.find((o) => o.id === f.salesOrderId)?.quotationId !== q.id ? '' : f.salesOrderId,
      };
    });
  }

  function pickSalesOrder(o: Options['salesOrders'][number] | undefined) {
    if (!o) {
      set('salesOrderId', '');
      return;
    }
    setForm((f) => ({
      ...f,
      salesOrderId: o.id,
      quotationId: o.quotationId,
      customerPoNumber: f.customerPoNumber || o.poNumber || '',
      contactId: f.contactId || o.contactId || '',
      amount: f.amount || String(o.amount),
    }));
    const q = options.quotations.find((x) => x.id === o.quotationId);
    if (q) pickQuotation(q);
  }

  function pickContact(id: string) {
    const c = options.contacts.find((x) => x.id === id);
    setForm((f) => ({ ...f, contactId: id, contactNumber: f.contactNumber || c?.phone || '' }));
  }

  const duration = workingDays(form.targetStart, form.targetFinish);
  const finishBeforeStart = !!form.targetStart && !!form.targetFinish && form.targetFinish < form.targetStart;
  const salesOrdersOffered = form.quotationId ? options.salesOrders.filter((o) => o.quotationId === form.quotationId) : options.salesOrders;
  const linkedQuotation = options.quotations.find((q) => q.id === form.quotationId);

  async function save() {
    setBusy(true);
    setError(null);
    const body = {
      siteId: form.siteId || null,
      contactId: form.contactId || null,
      quotationId: form.quotationId || null,
      salesOrderId: form.salesOrderId || null,
      jobId: form.jobId || null,
      projectName: form.projectName.trim(),
      contactNumber: form.contactNumber.trim() || null,
      title: form.title.trim(),
      scope: form.scope.trim(),
      targetStart: form.targetStart,
      targetFinish: form.targetFinish,
      projectManagerId: form.projectManagerId || null,
      projectEngineerId: form.projectEngineerId || null,
      projectLeadId: form.projectLeadId || null,
      supportIds: form.supportIds,
      customerPoNumber: form.customerPoNumber.trim() || null,
      amount: form.amount !== '' ? Number(form.amount) : null,
    };
    try {
      if (existing) {
        await api.patch(`/job-orders/${existing.id}`, body);
        toast('ok', 'Job order updated');
        onSaved(existing.id);
      } else {
        const created = await api.post<{ id: string; number: string }>('/job-orders', { customerId: form.customerId, ...body });
        toast('ok', `${created.number} raised — submit it when ready`);
        onSaved(created.id);
      }
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  }

  /** On the order now, so a person no longer listed still shows by name. */
  const onRecord = {
    projectManagerId: existing?.projectManager ?? null,
    projectEngineerId: existing?.projectEngineer ?? null,
    projectLeadId: existing?.projectLead ?? null,
  };
  const personSelect = (label: string, key: 'projectManagerId' | 'projectEngineerId' | 'projectLeadId', hint?: string) => (
    <Field label={label} hint={hint} htmlFor={`${idBase}-${key}`}>
      <PersonSelect
        id={`${idBase}-${key}`}
        value={form[key]}
        onChange={(id) => set(key, id)}
        people={people}
        current={onRecord[key]}
      />
    </Field>
  );

  return (
    <Modal
      title={existing ? `Modify job order ${existing.number}` : 'New job order'}
      onClose={onClose}
      wide
      footer={
        <ModalFoot onCancel={onClose} busy={busy}>
          <button
            type="button"
            className="btn btn-primary"
            onClick={save}
            disabled={
              busy ||
              !form.customerId ||
              form.projectName.trim().length < 2 ||
              form.title.trim().length < 3 ||
              form.scope.trim().length < 5 ||
              !form.targetStart ||
              !form.targetFinish ||
              finishBeforeStart
            }
          >
            {busy ? 'Saving…' : 'Save'}
          </button>
        </ModalFoot>
      }
    >
      <ErrorBox error={error} />

      <h4 className="svc-subhead">Links</h4>
      <div className="grid grid-2">
        {!customerLocked && searchCustomers ? (
          <Field label="Customer" htmlFor={`${idBase}-customer`}>
            <CustomerPicker
              inputId={`${idBase}-customer`}
              value={pickedCustomer}
              onError={setError}
              onChange={(c) => {
                setPickedCustomer(c);
                setForm((f) =>
                  (c?.id ?? '') === f.customerId
                    ? f
                    : { ...f, customerId: c?.id ?? '', siteId: '', contactId: '', contactNumber: '', quotationId: '', salesOrderId: '', jobId: '' },
                );
              }}
            />
          </Field>
        ) : (
          <Field label="Customer">
            <select
              value={form.customerId}
              disabled={customerLocked}
              onChange={(e) =>
                setForm({ ...form, customerId: e.target.value, siteId: '', contactId: '', contactNumber: '', quotationId: '', salesOrderId: '', jobId: '' })
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
        )}
        <Field
          label="Quotation"
          hint={
            linkedQuotation
              ? linkedQuotation.costed
                ? 'Approval builds the project from its costing'
                : 'No costing behind it yet — approval cannot build the project until there is'
              : 'Any quotation still on, one under negotiation included'
          }
        >
          <select value={form.quotationId} onChange={(e) => pickQuotation(options.quotations.find((q) => q.id === e.target.value))}>
            <option value="">— none —</option>
            {existing?.quotation && !options.quotations.some((q) => q.id === existing.quotation!.id) && (
              <option value={existing.quotation.id}>{existing.quotation.number}</option>
            )}
            {options.quotations.map((q) => (
              <option key={q.id} value={q.id}>
                {q.number} — {q.subject} ({OUTCOME_LABEL[q.outcome] ?? q.outcome.toLowerCase()})
              </option>
            ))}
          </select>
        </Field>
        <Field label="Sales order" hint="Optional — the order the work was booked on">
          <select value={form.salesOrderId} onChange={(e) => pickSalesOrder(options.salesOrders.find((o) => o.id === e.target.value))}>
            <option value="">— none —</option>
            {salesOrdersOffered.map((o) => (
              <option key={o.id} value={o.id}>
                {o.number} · {formatMoney(o.amount)} · {o.status.toLowerCase().replace(/_/g, ' ')}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Project" hint="Only when the project already exists — otherwise approval builds it">
          <select
            value={form.jobId}
            onChange={(e) => {
              const j = options.jobs.find((x) => x.id === e.target.value);
              setForm((f) => ({ ...f, jobId: e.target.value, projectName: f.projectName || j?.name || '', projectManagerId: f.projectManagerId || j?.projectManagerId || '' }));
            }}
          >
            <option value="">— none, to be built —</option>
            {options.jobs.map((j) => (
              <option key={j.id} value={j.id}>
                {j.number} — {j.name}
              </option>
            ))}
          </select>
        </Field>
      </div>

      <h4 className="svc-subhead">The project</h4>
      <div className="grid grid-2">
        <Field label="Project name">
          <input value={form.projectName} placeholder="Oxygen plant, Building B" onChange={(e) => set('projectName', e.target.value)} />
        </Field>
        <Field label="Site">
          <select value={form.siteId} onChange={(e) => set('siteId', e.target.value)}>
            <option value="">— none —</option>
            {options.sites.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
                {s.city ? ` · ${s.city}` : ''}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Contact person">
          <select value={form.contactId} onChange={(e) => pickContact(e.target.value)}>
            <option value="">— none —</option>
            {options.contacts.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Contact number">
          <input value={form.contactNumber} placeholder="0917 000 0000" onChange={(e) => set('contactNumber', e.target.value)} />
        </Field>
        <Field label="Target start">
          <input type="date" value={form.targetStart} onChange={(e) => set('targetStart', e.target.value)} />
        </Field>
        <Field
          label="Target finish"
          hint={finishBeforeStart ? 'Before the start' : form.targetStart && form.targetFinish ? `${daysLabel(duration)} (Mon–Fri)` : undefined}
        >
          <input type="date" value={form.targetFinish} min={form.targetStart || undefined} onChange={(e) => set('targetFinish', e.target.value)} />
        </Field>
      </div>

      <Field label="In one line">
        <input value={form.title} placeholder="Supply and install of the compressed air system" onChange={(e) => set('title', e.target.value)} />
      </Field>
      <Field label="Scope of work" hint="The complete details — what is supplied, installed, tested and handed over">
        <textarea rows={6} value={form.scope} onChange={(e) => set('scope', e.target.value)} />
      </Field>

      <h4 className="svc-subhead">Personnel to send</h4>
      <div className="grid grid-3">
        {personSelect('Project manager', 'projectManagerId', 'Approves the order first; runs the project')}
        {personSelect('Project engineer', 'projectEngineerId')}
        {personSelect('Project lead', 'projectLeadId')}
      </div>
      <Field label="Project support" hint="As many as the job needs">
        <PeoplePicker
          people={people.map(toPerson)}
          value={form.supportIds}
          onChange={(ids) => set('supportIds', ids)}
          exclude={[form.projectManagerId, form.projectEngineerId, form.projectLeadId].filter(Boolean)}
        />
      </Field>

      <h4 className="svc-subhead">Amount</h4>
      <div className="grid grid-2">
        <Field label="Customer PO">
          <input value={form.customerPoNumber} onChange={(e) => set('customerPoNumber', e.target.value)} />
        </Field>
        <Field label="Amount (before VAT)" hint={form.quotationId || form.salesOrderId ? 'Empty takes the linked document’s price' : 'Leave empty to bill on completion'}>
          <NumberInput kind="money" min={0} step="0.01" value={form.amount} onChange={(e) => set('amount', e.target.value)} />
        </Field>
      </div>
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
  const [modal, setModal] = useState<'edit' | 'ack' | 'invoice' | 'report' | null>(null);
  const confirm = useConfirm();

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

  const routeText = useMemo(
    () => (row?.route ?? []).map((s) => `${s.step}: ${s.names.length ? s.names.join(' or ') : 'nobody yet'}`).join(' › '),
    [row?.route],
  );

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

  /** Cancelling, asked in the confirm bar under the header — which shows a refusal and stays open. */
  async function cancel(reason: string) {
    await api.post(`/job-orders/${row!.id}/cancel`, { reason });
    toast('ok', 'Job order cancelled');
    await load();
  }

  const r = row;
  const canWriteReport = r.status === 'APPROVED' && !!r.visit && !r.visit.report && can(reportPermission(r.kind, 'create'));
  const canInvoice = r.status === 'COMPLETED' && r.billable && !r.invoice && can('gfin.ar.create');
  const personLine = (p: Person | null) => (p ? [p.name, p.position].filter(Boolean).join(' · ') : <span className="faint">—</span>);

  return (
    <div>
      <RecordHeader
        type="Job Order"
        code={r.number}
        title={r.projectName ?? r.title}
        status={r.status}
        statusExtra={JOB_ORDER_TONES}
        statusLabel={statusLabel(r.status)}
        amount={r.amount != null ? formatMoney(r.amount) : undefined}
        amountLabel="Amount (before VAT)"
        meta={
          <>
            {r.customer.name} · {r.title} · raised by {r.requestedBy.name} on {formatDate(r.createdAt)}
            {r.approvedAt ? ` · approved ${formatDate(r.approvedAt)}` : ''}
            {r.completedAt ? ` · completed ${formatDate(r.completedAt)}` : ''}
          </>
        }
        actions={
          <>
            {/* The main next step, by status: submit a draft, write the visit's report, bill a completed order. */}
            {r.canEdit && (
              <button
                type="button"
                className="btn btn-primary"
                disabled={busy}
                onClick={() => run('Submitted for approval', () => api.post(`/job-orders/${r.id}/submit`))}
              >
                Submit for approval
              </button>
            )}
            {canWriteReport && (
              <button type="button" className="btn btn-primary" onClick={() => setModal('report')} disabled={busy}>
                Write report
              </button>
            )}
            {canInvoice && (
              <button type="button" className="btn btn-primary" onClick={() => setModal('invoice')} disabled={busy}>
                Raise invoice
              </button>
            )}
            {r.canAcknowledge && (
              <button type="button" className="btn" onClick={() => setModal('ack')} disabled={busy}>
                {r.customerAcknowledgedBy ? 'Re-record acknowledgement' : 'Record acknowledgement'}
              </button>
            )}
          </>
        }
        print={`/api/job-orders/${r.id}/pdf`}
        more={[
          r.canCancel && {
            label: 'Cancel job order',
            danger: true,
            confirm: {
              title: `Cancel ${r.number}?`,
              body: r.job ? `Project ${r.job.number} stays — a project is cancelled from its own page.` : undefined,
              confirmLabel: 'Cancel job order',
              reason: 'required',
              minReason: 3,
              reasonLabel: 'Why is it cancelled?',
              onConfirm: cancel,
            },
          },
        ]}
        modify={r.canEdit ? () => setModal('edit') : undefined}
        confirm={confirm}
      />

      <DocumentApproval documentType="job_order" documentId={r.id} reloadToken={reload} />

      <ErrorBox error={error} />

      {(r.status === 'DRAFT' || r.status === 'REJECTED') && r.canEdit && (
        <div className="alert info">
          Submit for approval sends it to {routeText || 'the route in Admin › Approval Workflows'}. Approval builds the project
          {r.quotation ? ` from ${r.quotation.number}'s costing` : ' — link a quotation with a costing first, or it will be approved without one'}.
        </div>
      )}
      {r.status === 'PENDING_APPROVAL' && (
        <div className="alert info">With the approvers — the project manager, then the team leader. To change it, ask them to return it.</div>
      )}
      {r.status === 'REJECTED' && <div className="alert warn">Returned. Correct what the approver asked for, then submit it again.</div>}
      {r.status === 'CANCELLED' && (
        <div className="alert warn">
          Cancelled{r.cancelledAt ? ` on ${formatDate(r.cancelledAt)}` : ''}: {r.cancelReason ?? 'no reason recorded'}
        </div>
      )}
      {r.status === 'APPROVED' && !r.job && (
        <div className="alert warn">Approved, but no project was built — the linked quotation had no usable costing. Build it from the quotation once it is costed.</div>
      )}

      <div className="svc-detail-grid">
        <section className="card">
          <h3 className="card-title">The project</h3>
          <dl className="kv">
            <dt>Project name</dt>
            <dd>{r.projectName ?? r.title}</dd>
            <dt>Customer</dt>
            <dd>
              {can('gops.customers.view_all') ? <Link to={`/g-ops/customers/${r.customer.id}`}>{r.customer.name}</Link> : r.customer.name}
            </dd>
            <dt>Site</dt>
            <dd>{r.site ? `${r.site.name}${r.site.city ? ` · ${r.site.city}` : ''}` : '—'}</dd>
            <dt>Contact</dt>
            <dd>{r.contact?.name ?? '—'}</dd>
            <dt>Contact number</dt>
            <dd>{r.contactNumber ?? r.contact?.phone ?? '—'}</dd>
            <dt>Target start</dt>
            <dd>{formatDate(r.targetStart)}</dd>
            <dt>Target finish</dt>
            <dd>{formatDate(r.targetFinish)}</dd>
            <dt>Duration</dt>
            <dd>{daysLabel(r.durationDays)}</dd>
          </dl>
        </section>

        <section className="card">
          <h3 className="card-title">Links and amount</h3>
          <dl className="kv">
            <dt>Quotation</dt>
            <dd>
              {r.quotation ? (
                <>
                  <Link to={`/g-ops/quotations/${r.quotation.id}`} className="mono">
                    {r.quotation.number}
                  </Link>{' '}
                  <span className="faint">
                    {r.quotation.subject} · {OUTCOME_LABEL[r.quotation.outcome] ?? r.quotation.outcome.toLowerCase()}
                  </span>
                </>
              ) : (
                '—'
              )}
            </dd>
            <dt>Sales order</dt>
            <dd>
              {r.salesOrder ? (
                <Link to={`/g-ops/sales-orders/${r.salesOrder.id}`} className="mono">
                  {r.salesOrder.number}
                </Link>
              ) : (
                '—'
              )}
            </dd>
            <dt>Project</dt>
            <dd>
              {r.job ? (
                <>
                  <Link to={`/g-ops/projects/${r.job.id}`} className="mono">
                    {r.job.number}
                  </Link>{' '}
                  <span className="faint">{r.job.name}</span> <StatusBadge status={r.job.status} />
                </>
              ) : (
                <span className="faint">{r.status === 'APPROVED' || r.status === 'COMPLETED' ? 'none built' : 'built on approval'}</span>
              )}
            </dd>
            <dt>Customer PO</dt>
            <dd>{r.customerPoNumber ?? '—'}</dd>
            <dt>Amount</dt>
            <dd className="mono">{r.amount != null ? formatMoney(r.amount) : 'to be billed on completion'}</dd>
            {r.invoice && (
              <>
                <dt>Invoice</dt>
                <dd>
                  <Link to={`/g-fin/ar/${r.invoice.id}`} className="mono">
                    {r.invoice.number}
                  </Link>{' '}
                  <StatusBadge status={r.invoice.status} />
                </dd>
              </>
            )}
            {r.customerAcknowledgedBy && (
              <>
                <dt>Acknowledged by</dt>
                <dd>
                  {r.customerAcknowledgedBy}
                  {r.customerAcknowledgedAt && <span className="faint"> on {formatDate(r.customerAcknowledgedAt)}</span>}
                </dd>
              </>
            )}
          </dl>
        </section>
      </div>

      <section className="card">
        <h3 className="card-title">Scope of work</h3>
        <p className="svc-text">{r.scope ?? r.description}</p>
      </section>

      <section className="card">
        <h3 className="card-title">Personnel to send</h3>
        <dl className="kv">
          <dt>Project manager</dt>
          <dd>{personLine(r.projectManager)}</dd>
          <dt>Project engineer</dt>
          <dd>{personLine(r.projectEngineer)}</dd>
          <dt>Project lead</dt>
          <dd>{personLine(r.projectLead)}</dd>
          <dt>Project support</dt>
          <dd>{r.support.length ? r.support.map((p) => p.name).join(', ') : <span className="faint">—</span>}</dd>
        </dl>
      </section>

      {r.visit && (
        <section className="card">
          <h3 className="card-title">Service visit</h3>
          <dl className="kv">
            <dt>Engineer</dt>
            <dd>{r.assignedTo?.name ?? <span className="faint">unassigned</span>}</dd>
            <dt>Visit</dt>
            <dd>
              <Link to={`/g-ops/visits?visit=${r.visit.id}`} className="mono">
                {r.visit.number}
              </Link>{' '}
              <VisitBadge visit={{ status: r.visit.status, overdue: false }} /> <span className="faint">due {formatDate(r.visit.dueDate)}</span>
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
        </section>
      )}

      <Attachments
        entityType="job_order"
        entityId={r.id}
        title="Photos and documents"
        hint="The customer’s email, the PO, drawings"
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
      {modal === 'ack' && (
        <AcknowledgeModal
          title={r.customerAcknowledgedBy ? 'Re-record acknowledgement' : 'Record acknowledgement'}
          initial={r.customerAcknowledgedBy ?? r.contact?.name ?? ''}
          onClose={() => setModal(null)}
          onSave={async (name) => {
            await api.patch(`/job-orders/${r.id}/acknowledge`, { customerAcknowledgedBy: name });
            toast('ok', 'Acknowledgement recorded');
            setModal(null);
            await load();
          }}
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
        <NewReportModal preset={{ visitId: r.visit.id }} onClose={() => setModal(null)} onCreated={(reportId) => navigate(`/g-ops/service-reports/${reportId}`)} />
      )}
    </div>
  );
}

/**
 * Who signed for the order on the customer's side — a name, kept on the
 * order and printed in the customer's slot. It gathers a value (prefilled
 * with the contact), not a yes, so it is a small form rather than a confirm.
 */
function AcknowledgeModal({
  title,
  initial,
  onClose,
  onSave,
}: {
  title: string;
  initial: string;
  onClose: () => void;
  onSave: (name: string) => Promise<void>;
}) {
  const [value, setValue] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  async function save() {
    setBusy(true);
    setError(null);
    try {
      await onSave(value.trim());
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  }

  return (
    <Modal
      title={title}
      onClose={onClose}
      footer={
        <ModalFoot onCancel={onClose} busy={busy}>
          <button type="button" className="btn btn-primary" disabled={busy || value.trim().length < 2} onClick={() => void save()}>
            {busy ? 'Saving…' : 'Save'}
          </button>
        </ModalFoot>
      }
    >
      <ErrorBox error={error} />
      <Field label="Who signed for it?" hint="The name printed in the customer’s slot on the job order">
        <input value={value} onChange={(e) => setValue(e.target.value)} autoFocus />
      </Field>
    </Modal>
  );
}

/**
 * Billing a completed chargeable order — through the ONE invoice path,
 * `POST /invoices` with the order's id, which refuses an order whose report
 * is not approved and a second invoice. (Orders raised as service calls
 * before 2026-10-09; a project work order is billed through its project.)
 */
function InvoiceModal({ order, onClose, onRaised }: { order: JobOrderRow; onClose: () => void; onRaised: (invoiceId: string) => void }) {
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
      title={`Raise invoice for ${order.number}`}
      onClose={onClose}
      footer={
        <ModalFoot onCancel={onClose} busy={busy}>
          <button type="button" className="btn btn-primary" onClick={raise} disabled={busy || !(Number(amount) > 0)}>
            {busy ? 'Raising…' : 'Raise invoice'}
          </button>
        </ModalFoot>
      }
    >
      <ErrorBox error={error} />
      <p className="muted">
        One line, “{order.number} — {order.title}”, to {order.customer.name}. VAT is added and EWT withheld at the rates in Settings, as on every
        invoice.
      </p>
      <div className="grid grid-2">
        <Field label="Amount (before VAT)" hint={order.amount != null ? 'The agreed price' : 'Time and materials — type what was agreed'}>
          <NumberInput kind="money" min={0} step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} />
        </Field>
        <Field label="Due date" hint="Empty uses the default payment terms">
          <input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
        </Field>
      </div>
    </Modal>
  );
}
