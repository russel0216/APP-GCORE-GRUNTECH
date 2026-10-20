import { useCallback, useEffect, useId, useMemo, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api, qs } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { DataList, type Column } from '../../components/DataList';
import { RecordHeader } from '../../components/RecordHeader';
import { useConfirm } from '../../components/Confirm';
import { DocumentApproval, DecisionNote } from '../../components/ApprovalStepper';
import { Attachments } from '../../components/Attachments';
import { PersonSelect, usePeople } from '../../components/People';
import { CustomerPicker, type CustomerRef } from '../../components/CustomerPicker';
import { ErrorBox, Field, Loading, Modal, ModalFoot, StatusBadge, formatDate, formatMoney, useToast, type Tone } from '../../components/ui';
import { todayLocal } from '../../lib/day';
import { NumberInput } from '../../components/NumberInput';
import { Stat } from '../../components/charts';
import { KINDS, KIND_LABEL, NewReportModal, reportPermission } from './Reports';
import { VisitBadge } from './Schedule';
import { AcknowledgeModal, BasisBadge, InvoiceModal } from './JobOrders';
import { useTeams } from '../finance/Receivables';

/**
 * Service JOs — the SERVICE CALL on a registered machine (2026-10-20, the
 * owner's revised Aftermarket UI). The register under Aftermarket, the form
 * (the machine from the Installation Base, the service type, the priority,
 * the day it is needed by, the engineer) and the record page. The route is
 * the Aftermarket Manager on the requester's team, then the Team Leader;
 * approval BOOKS THE VISIT, and the approved report on it completes the JO.
 */

const STATUSES = [
  { value: 'DRAFT', label: 'Draft' },
  { value: 'PENDING_APPROVAL', label: 'AM / TL approval' },
  { value: 'APPROVED', label: 'Dispatch pending / In progress' },
  { value: 'COMPLETED', label: 'Done' },
  { value: 'REJECTED', label: 'Returned' },
  { value: 'CANCELLED', label: 'Cancelled' },
];

const BASES = [
  { value: 'CONTRACT', label: 'Service contract' },
  { value: 'WARRANTY', label: 'Warranty' },
  { value: 'CHARGEABLE', label: 'Chargeable' },
  { value: 'GOODWILL', label: 'Goodwill' },
];

const SJO_TONES: Record<string, Tone> = { REJECTED: 'warn' };
/** The spec's words, toned by what they mean. */
const STAGE_TONE: Record<string, Tone> = { 'Dispatch pending': 'warn', 'In progress': 'info', 'Missed visit': 'danger', Done: 'ok' };

interface Person {
  id: string;
  name: string;
  position: string | null;
}

export interface ServiceJoRow {
  id: string;
  number: string;
  status: string;
  kind: string;
  urgent: boolean;
  title: string;
  description: string;
  scope: string | null;
  neededBy: string;
  requestedFor: string;
  chargeBasis: string;
  underWarranty: boolean;
  billable: boolean;
  amount: number | null;
  customerPoNumber: string | null;
  contactNumber: string | null;
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
  asset: { id: string; code: string; name: string; model: string | null; serialNo: string | null; address: string | null; warrantyEndsAt: string | null } | null;
  contract: { id: string; number: string; status: string; endsAt: string } | null;
  job: { id: string; number: string; name: string; status: string } | null;
  requestedBy: Person;
  assignedTo: (Person & { team: { id: string; code: string; name: string } | null }) | null;
  team: { id: string; code: string; name: string } | null;
  stageLabel: string;
  visit: {
    id: string;
    number: string;
    status: string;
    dueDate: string;
    slot: string;
    performedAt: string | null;
    report: { id: string; number: string; status: string } | null;
  } | null;
  invoice: { id: string; number: string; status: string } | null;
}

interface ServiceJoDetail extends ServiceJoRow {
  canEdit: boolean;
  canWithdraw: boolean;
  canCancel: boolean;
  canAcknowledge: boolean;
  route: { step: string; names: string[] }[];
}

const machineLine = (a: ServiceJoRow['asset']) => (a ? [a.name, a.model, a.serialNo].filter(Boolean).join(' · ') : null);

// ── The list ────────────────────────────────────────────────────────────────

function columns(): Column<ServiceJoRow>[] {
  return [
    { key: 'number', label: 'SJO No.', sortKey: 'number', width: '130px', render: (r) => <span className="mono">{r.number}</span> },
    { key: 'requested', label: 'Date req.', sortKey: 'createdAt', render: (r) => formatDate(r.createdAt) },
    {
      key: 'machine',
      label: 'Customer / equipment',
      render: (r) => (
        <div>
          <div>
            <strong>{r.customer.name}</strong>
          </div>
          <div className="faint">{machineLine(r.asset) ?? r.title}</div>
        </div>
      ),
    },
    {
      key: 'kind',
      label: 'Service type',
      render: (r) => (
        <div>
          <div>{KIND_LABEL[r.kind] ?? r.kind}</div>
          {r.urgent && <StatusBadge status="URGENT" extra={{ URGENT: 'danger' }} label="Urgent" />}
        </div>
      ),
    },
    { key: 'neededBy', label: 'Needed by', sortKey: 'requestedFor', render: (r) => formatDate(r.neededBy) },
    {
      key: 'engineer',
      label: 'Assigned engineer',
      render: (r) =>
        r.assignedTo ? (
          <div>
            <div>{r.assignedTo.name}</div>
            {r.assignedTo.team && <div className="faint">{r.assignedTo.team.code}</div>}
          </div>
        ) : (
          <span className="faint">—</span>
        ),
    },
    { key: 'basis', label: 'Covered by', optional: true, render: (r) => <BasisBadge basis={r.chargeBasis} /> },
    { key: 'requester', label: 'Requester', optional: true, render: (r) => r.requestedBy.name },
    { key: 'task', label: 'Task', optional: true, render: (r) => r.title },
    {
      key: 'visit',
      label: 'Visit',
      optional: true,
      render: (r) =>
        r.visit ? (
          <div>
            <span className="mono">{r.visit.number}</span>
            <div className="faint">
              {formatDate(r.visit.dueDate)} · {r.visit.slot}
            </div>
          </div>
        ) : (
          <span className="faint">not booked</span>
        ),
    },
    {
      key: 'amount',
      label: 'Amount',
      align: 'right',
      optional: true,
      render: (r) => (r.amount != null ? <span className="mono">{formatMoney(r.amount)}</span> : <span className="faint">—</span>),
    },
    {
      key: 'status',
      label: 'Status',
      render: (r) => <StatusBadge status={STAGE_TONE[r.stageLabel] ? r.stageLabel : r.status} extra={{ ...SJO_TONES, ...STAGE_TONE }} label={r.stageLabel} />,
    },
  ];
}

export function ServiceJobOrders() {
  const { can } = useAuth();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  // `?new=1&customerId=&assetId=` — how the machine's page starts one.
  const [raising, setRaising] = useState(() => params.get('new') === '1' && can('gops.service_job_orders.create'));
  const [prefill] = useState(() => ({ customerId: params.get('customerId') ?? undefined, assetId: params.get('assetId') ?? undefined }));
  const { people } = usePeople();
  const teams = useTeams();

  function closeRaising() {
    setRaising(false);
    if (params.has('new')) {
      const next = new URLSearchParams(params);
      for (const k of ['new', 'customerId', 'assetId']) next.delete(k);
      setParams(next, { replace: true });
    }
  }

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Service JO</h1>
        </div>
      </div>

      <DataList<ServiceJoRow>
        listKey="service-job-orders"
        endpoint="/service-job-orders"
        columns={columns()}
        rowKey={(r) => r.id}
        scoped
        onRowClick={(r) => navigate(`/g-ops/service-job-orders/${r.id}`)}
        searchPlaceholder="Search SJO No., customer, machine, serial…"
        emptyTitle="No service JOs yet"
        emptyHint="Raise one on a registered machine — approval books the visit."
        printPath="/api/service-job-orders/pdf"
        summary={(raw) => {
          const s = raw as { open?: number; pendingApproval?: number; dispatchPending?: number; urgent?: number; done?: number };
          return (
            <>
              <Stat label="Active service JOs" value={s.open ?? 0} sub="Awaiting approval or in progress" />
              <Stat label="Pending approval" value={s.pendingApproval ?? 0} sub="AM / TL approval" accent={s.pendingApproval ? 'warn' : undefined} />
              <Stat label="Dispatch pending" value={s.dispatchPending ?? 0} sub="Visit booked, day to come" />
              <Stat label="Urgent" value={s.urgent ?? 0} sub="Open and urgent" accent={s.urgent ? 'danger' : undefined} />
              <Stat label="Done" value={s.done ?? 0} sub="Report approved" />
            </>
          );
        }}
        filters={[
          { key: 'status', label: 'Status', options: STATUSES },
          { key: 'kind', label: 'Service type', options: KINDS },
          { key: 'urgent', label: 'Urgent', options: [{ value: 'true', label: 'Urgent only' }] },
          { key: 'open', label: 'Open', options: [{ value: 'true', label: 'Awaiting approval or approved' }] },
          { key: 'chargeBasis', label: 'Covered by', options: BASES },
          { key: 'assignedToId', label: 'Assigned engineer', options: people.map((p) => ({ value: p.id, label: p.name })) },
          { key: 'requestedById', label: 'Requester', options: people.map((p) => ({ value: p.id, label: p.name })) },
          { key: 'teamId', label: 'Team', options: [...teams.map((t) => ({ value: t.id, label: `${t.code} — ${t.name}` })), { value: 'none', label: 'No team' }] },
          { key: 'createdFrom', toKey: 'createdTo', label: 'Date requested', type: 'dateRange' },
          { key: 'from', toKey: 'to', label: 'Needed by', type: 'dateRange' },
        ]}
        actions={
          can('gops.service_job_orders.create') ? (
            <button type="button" className="btn btn-primary btn-sm" onClick={() => setRaising(true)}>
              + New service JO
            </button>
          ) : null
        }
      />

      {raising && (
        <ServiceJoModal
          prefill={prefill}
          onClose={closeRaising}
          onSaved={(id) => {
            setRaising(false);
            navigate(`/g-ops/service-job-orders/${id}`);
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
  assets: {
    id: string;
    code: string;
    name: string;
    model: string | null;
    serialNo: string | null;
    siteId: string | null;
    address: string | null;
    underWarranty: boolean;
    contractId: string | null;
    contractNumber: string | null;
  }[];
  contracts: { id: string; number: string; endsAt: string }[];
}

const NO_OPTIONS: Options = { sites: [], contacts: [], assets: [], contracts: [] };

export function ServiceJoModal({
  prefill,
  existing,
  onClose,
  onSaved,
}: {
  prefill?: { customerId?: string; assetId?: string };
  existing?: ServiceJoRow;
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
  const customerLocked = !!existing || !!prefill?.customerId;
  const searchCustomers = can('gops.customers.view_all');
  const [pickedCustomer, setPickedCustomer] = useState<CustomerRef | null>(null);
  const teams = useTeams();

  const [form, setForm] = useState(() => ({
    customerId: existing?.customer.id ?? prefill?.customerId ?? '',
    assetId: existing?.asset?.id ?? prefill?.assetId ?? '',
    contractId: existing?.contract?.id ?? '',
    siteId: existing?.site?.id ?? '',
    contactId: existing?.contact?.id ?? '',
    contactNumber: existing?.contactNumber ?? '',
    title: existing?.title ?? '',
    scope: existing?.scope ?? existing?.description ?? '',
    kind: existing?.kind ?? 'CORRECTIVE',
    urgent: existing?.urgent ?? false,
    neededBy: existing?.neededBy.slice(0, 10) ?? todayLocal(),
    assignedToId: existing?.assignedTo?.id ?? '',
    teamId: existing?.team?.id ?? '',
    // Empty follows the facts: the contract, else the warranty, else chargeable.
    chargeBasis: existing?.chargeBasis ?? '',
    customerPoNumber: existing?.customerPoNumber ?? '',
    amount: existing?.amount != null ? String(existing.amount) : '',
  }));
  const set = <K extends keyof typeof form>(k: K, v: (typeof form)[K]) => setForm((f) => ({ ...f, [k]: v }));

  useEffect(() => {
    if (searchCustomers && !customerLocked) return;
    api
      .get<{ customers: { id: string; name: string }[] }>('/service-job-orders/options')
      .then((d) => setCustomers(d.customers))
      .catch(() => setCustomers([]));
  }, [searchCustomers, customerLocked]);

  useEffect(() => {
    if (!form.customerId) {
      setOptions(NO_OPTIONS);
      return;
    }
    api
      .get<Options>(`/service-job-orders/options${qs({ customerId: form.customerId })}`)
      .then(setOptions)
      .catch(() => setOptions(NO_OPTIONS));
  }, [form.customerId]);

  /** Picking a machine fills what it knows: its site and the contract covering it. */
  function pickAsset(id: string) {
    const a = options.assets.find((x) => x.id === id);
    setForm((f) => ({ ...f, assetId: id, siteId: f.siteId || a?.siteId || '', contractId: a?.contractId ?? (id ? '' : f.contractId) }));
  }

  // A prefilled machine fills the form once its facts arrive.
  useEffect(() => {
    if (existing || !prefill?.assetId || !options.assets.length) return;
    pickAsset(prefill.assetId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [options.assets]);

  function pickContact(id: string) {
    const c = options.contacts.find((x) => x.id === id);
    setForm((f) => ({ ...f, contactId: id, contactNumber: f.contactNumber || c?.phone || '' }));
  }

  const asset = options.assets.find((a) => a.id === form.assetId);
  const coverHint = form.contractId
    ? `Covered by contract ${options.contracts.find((c) => c.id === form.contractId)?.number ?? asset?.contractNumber ?? ''}`
    : asset?.underWarranty
      ? 'Under warranty on the day it was registered — the server decides on the needed-by day'
      : 'No contract or warranty: chargeable unless you say otherwise';

  const incomplete = !form.customerId || form.title.trim().length < 3 || form.scope.trim().length < 5 || !form.neededBy || !form.kind;

  async function save(andSubmit = false) {
    setBusy(true);
    setError(null);
    const body = {
      assetId: form.assetId || null,
      contractId: form.contractId || null,
      siteId: form.siteId || null,
      contactId: form.contactId || null,
      contactNumber: form.contactNumber.trim() || null,
      title: form.title.trim(),
      scope: form.scope.trim(),
      kind: form.kind,
      urgent: form.urgent,
      neededBy: form.neededBy,
      assignedToId: form.assignedToId || null,
      teamId: form.teamId || null,
      chargeBasis: form.chargeBasis || null,
      customerPoNumber: form.customerPoNumber.trim() || null,
      amount: form.amount !== '' ? Number(form.amount) : null,
    };
    try {
      if (existing) {
        await api.patch(`/service-job-orders/${existing.id}`, body);
        toast('ok', 'Service JO updated');
        onSaved(existing.id);
      } else {
        const created = await api.post<{ id: string; number: string }>('/service-job-orders', { customerId: form.customerId, ...body });
        if (andSubmit) {
          try {
            await api.post(`/service-job-orders/${created.id}/submit`);
            toast('ok', `${created.number} sent for approval`);
          } catch (err) {
            toast('error', `${created.number} saved as a draft — ${err instanceof Error ? err.message : 'it could not be sent'}`);
          }
        } else {
          toast('ok', `${created.number} saved as a draft`);
        }
        onSaved(created.id);
      }
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  }

  return (
    <Modal
      title={existing ? `Modify service JO ${existing.number}` : 'New service JO'}
      onClose={onClose}
      wide
      footer={
        <ModalFoot onCancel={onClose} busy={busy}>
          {!existing && (
            <button type="button" className="btn" onClick={() => void save(false)} disabled={busy || incomplete}>
              Save as draft
            </button>
          )}
          <button type="button" className="btn btn-primary" onClick={() => void save(!existing)} disabled={busy || incomplete}>
            {busy ? 'Saving…' : existing ? 'Save' : 'Submit for approval'}
          </button>
        </ModalFoot>
      }
    >
      <ErrorBox error={error} />

      <h4 className="svc-subhead">The machine</h4>
      <div className="grid grid-2">
        {!customerLocked && searchCustomers ? (
          <Field label="Customer" htmlFor={`${idBase}-customer`}>
            <CustomerPicker
              inputId={`${idBase}-customer`}
              value={pickedCustomer}
              onError={setError}
              allowCreate={false}
              onChange={(c) => {
                setPickedCustomer(c);
                setForm((f) => ((c?.id ?? '') === f.customerId ? f : { ...f, customerId: c?.id ?? '', assetId: '', contractId: '', siteId: '', contactId: '', contactNumber: '' }));
              }}
            />
          </Field>
        ) : (
          <Field label="Customer">
            <select
              value={form.customerId}
              disabled={customerLocked}
              onChange={(e) => setForm({ ...form, customerId: e.target.value, assetId: '', contractId: '', siteId: '', contactId: '', contactNumber: '' })}
            >
              <option value="">— choose —</option>
              {existing && !customers.some((c) => c.id === existing.customer.id) && <option value={existing.customer.id}>{existing.customer.name}</option>}
              {customers.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </Field>
        )}
        <Field label="Equipment" hint={asset ? [asset.code, asset.address].filter(Boolean).join(' · ') || undefined : 'From the Installation Base — leave empty for a call on no registered machine'}>
          <select value={form.assetId} onChange={(e) => pickAsset(e.target.value)}>
            <option value="">— none registered —</option>
            {existing?.asset && !options.assets.some((a) => a.id === existing.asset!.id) && (
              <option value={existing.asset.id}>{machineLine(existing.asset)}</option>
            )}
            {options.assets.map((a) => (
              <option key={a.id} value={a.id}>
                {[a.name, a.model, a.serialNo].filter(Boolean).join(' · ')}
              </option>
            ))}
          </select>
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
      </div>

      <h4 className="svc-subhead">The service</h4>
      <div className="grid grid-3">
        <Field label="Service type">
          <select value={form.kind} onChange={(e) => set('kind', e.target.value)}>
            {KINDS.map((k) => (
              <option key={k.value} value={k.value}>
                {k.label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Priority">
          <select value={form.urgent ? 'URGENT' : 'NORMAL'} onChange={(e) => set('urgent', e.target.value === 'URGENT')}>
            <option value="NORMAL">Normal</option>
            <option value="URGENT">Urgent</option>
          </select>
        </Field>
        <Field label="Needed by" hint="Approval books the visit on this day">
          <input type="date" value={form.neededBy} onChange={(e) => set('neededBy', e.target.value)} />
        </Field>
        <Field label="Assigned engineer" htmlFor={`${idBase}-engineer`} hint="Who goes — the visit is assigned to them">
          <PersonSelect id={`${idBase}-engineer`} value={form.assignedToId} onChange={(id) => set('assignedToId', id)} people={people} current={existing?.assignedTo ?? null} />
        </Field>
        <Field label="Team" hint="Empty takes the requester's own team">
          <select value={form.teamId} onChange={(e) => set('teamId', e.target.value)}>
            <option value="">— the requester's team —</option>
            {teams.map((t) => (
              <option key={t.id} value={t.id}>
                {t.code} — {t.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Covered by" hint={coverHint}>
          <select value={form.chargeBasis} onChange={(e) => set('chargeBasis', e.target.value)}>
            <option value="">— decided from the contract and warranty —</option>
            {BASES.map((b) => (
              <option key={b.value} value={b.value}>
                {b.label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Service contract" hint="The contract covering the work, if any">
          <select value={form.contractId} onChange={(e) => set('contractId', e.target.value)}>
            <option value="">— none —</option>
            {existing?.contract && !options.contracts.some((c) => c.id === existing.contract!.id) && <option value={existing.contract.id}>{existing.contract.number}</option>}
            {options.contracts.map((c) => (
              <option key={c.id} value={c.id}>
                {c.number} · to {formatDate(c.endsAt)}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <Field label="Task / short title">
        <input value={form.title} placeholder="Purity dropping at the outlet" onChange={(e) => set('title', e.target.value)} />
      </Field>
      <Field label="Scope of work" hint="What the customer reported and what is to be done">
        <textarea rows={5} value={form.scope} onChange={(e) => set('scope', e.target.value)} />
      </Field>

      <h4 className="svc-subhead">Amount</h4>
      <div className="grid grid-2">
        <Field label="Customer PO">
          <input value={form.customerPoNumber} onChange={(e) => set('customerPoNumber', e.target.value)} />
        </Field>
        <Field label="Amount (before VAT)" hint="Chargeable work — leave empty to bill on completion">
          <NumberInput kind="money" min={0} step="0.01" value={form.amount} onChange={(e) => set('amount', e.target.value)} />
        </Field>
      </div>
    </Modal>
  );
}

// ── One service JO ──────────────────────────────────────────────────────────

export function ServiceJobOrderDetail() {
  const { id } = useParams<{ id: string }>();
  const { can } = useAuth();
  const navigate = useNavigate();
  const toast = useToast();
  const [row, setRow] = useState<ServiceJoDetail | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [reload, setReload] = useState(0);
  const [modal, setModal] = useState<'edit' | 'ack' | 'invoice' | 'report' | null>(null);
  const confirm = useConfirm();

  const load = useCallback(async () => {
    if (!id) return;
    try {
      setRow(await api.get<ServiceJoDetail>(`/service-job-orders/${id}`));
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

  const routeText = useMemo(() => (row?.route ?? []).map((s) => `${s.step}: ${s.names.length ? s.names.join(' or ') : 'nobody yet'}`).join(' › '), [row?.route]);

  if (loading) return <Loading />;
  if (!row) return <ErrorBox error={error ?? new Error('Service JO not found')} />;

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

  async function cancel(reason: string) {
    await api.post(`/service-job-orders/${row!.id}/cancel`, { reason });
    toast('ok', 'Service JO cancelled');
    await load();
  }

  async function withdraw() {
    await api.post(`/service-job-orders/${row!.id}/withdraw`);
    toast('ok', `${row!.number} pulled back to draft`);
    await load();
  }

  async function remove() {
    await api.del(`/service-job-orders/${row!.id}`);
    toast('ok', `${row!.number} deleted`);
    navigate('/g-ops/service-job-orders');
  }

  const r = row;
  const canWriteReport = r.status === 'APPROVED' && !!r.visit && !r.visit.report && can(reportPermission(r.kind, 'create'));
  const canInvoice = r.status === 'COMPLETED' && r.billable && !r.invoice && can('gfin.ar.create');

  return (
    <div>
      <RecordHeader
        type="Service JO"
        code={r.number}
        title={r.title}
        status={STAGE_TONE[r.stageLabel] ? r.stageLabel : r.status}
        statusExtra={{ ...SJO_TONES, ...STAGE_TONE }}
        statusLabel={r.stageLabel}
        amount={r.amount != null ? formatMoney(r.amount) : undefined}
        amountLabel="Amount (before VAT)"
        meta={
          <>
            {r.customer.name}
            {r.asset ? ` · ${machineLine(r.asset)}` : ''} · {KIND_LABEL[r.kind] ?? r.kind}
            {r.urgent ? ' · URGENT' : ''} · raised by {r.requestedBy.name} on {formatDate(r.createdAt)}
            {r.approvedAt ? ` · approved ${formatDate(r.approvedAt)}` : ''}
            {r.completedAt ? ` · completed ${formatDate(r.completedAt)}` : ''}
          </>
        }
        actions={
          <>
            {r.canEdit && (
              <button type="button" className="btn btn-primary" disabled={busy} onClick={() => run('Submitted for approval', () => api.post(`/service-job-orders/${r.id}/submit`))}>
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
        print={`/api/service-job-orders/${r.id}/pdf`}
        more={[
          r.canWithdraw && {
            label: 'Pull back to draft',
            confirm: {
              title: `Pull ${r.number} back to draft?`,
              body: 'Its approval request is withdrawn and the approvers are told.',
              confirmLabel: 'Pull back',
              onConfirm: withdraw,
            },
          },
          r.canCancel && {
            label: 'Cancel service JO',
            danger: true,
            confirm: {
              title: `Cancel ${r.number}?`,
              body: r.visit ? `Visit ${r.visit.number} is cancelled with it.` : undefined,
              confirmLabel: 'Cancel service JO',
              reason: 'required',
              minReason: 3,
              reasonLabel: 'Why is it cancelled?',
              onConfirm: cancel,
            },
          },
          r.status === 'CANCELLED' &&
            can('gops.service_job_orders.delete') && {
              label: 'Delete',
              danger: true,
              confirm: {
                title: `Delete ${r.number}?`,
                body: 'This cancelled service JO goes for good. Its number is not reused.',
                confirmLabel: 'Delete',
                onConfirm: remove,
              },
            },
        ]}
        modify={r.canEdit ? () => setModal('edit') : undefined}
        confirm={confirm}
      />

      <DecisionNote documentType="service_job_order" documentId={r.id} reloadToken={reload} />
      <DocumentApproval documentType="service_job_order" documentId={r.id} reloadToken={reload} />

      <ErrorBox error={error} />

      {(r.status === 'DRAFT' || r.status === 'REJECTED') && r.canEdit && (
        <div className="alert info">
          Submit for approval sends it to {routeText || 'the route in Admin › Approval Workflows'}. Approval books the visit on {formatDate(r.neededBy)}
          {r.assignedTo ? ` for ${r.assignedTo.name}` : ''}.
        </div>
      )}
      {r.status === 'PENDING_APPROVAL' && <div className="alert info">With the approvers — the Aftermarket Manager, then the team leader. To change it, pull it back to draft.</div>}
      {r.status === 'REJECTED' && <div className="alert warn">Returned. Correct what the approver asked for, then submit it again.</div>}
      {r.status === 'CANCELLED' && (
        <div className="alert warn">
          Cancelled{r.cancelledAt ? ` on ${formatDate(r.cancelledAt)}` : ''}: {r.cancelReason ?? 'no reason recorded'}
        </div>
      )}

      <div className="svc-detail-grid">
        <section className="card">
          <h3 className="card-title">The machine</h3>
          <dl className="kv">
            <dt>Customer</dt>
            <dd>{can('gops.customers.view_all') ? <Link to={`/g-ops/customers/${r.customer.id}`}>{r.customer.name}</Link> : r.customer.name}</dd>
            <dt>Equipment</dt>
            <dd>
              {r.asset ? (
                <>
                  {can('gops.installed_base.view_all') || can('gops.installed_base.view_own') ? <Link to={`/g-ops/installed-base/${r.asset.id}`}>{r.asset.name}</Link> : r.asset.name}
                  {r.asset.model || r.asset.serialNo ? <span className="faint"> · {[r.asset.model, r.asset.serialNo].filter(Boolean).join(' · ')}</span> : null}
                </>
              ) : (
                <span className="faint">no registered machine</span>
              )}
            </dd>
            <dt>Location</dt>
            <dd>{r.site ? `${r.site.name}${r.site.city ? ` · ${r.site.city}` : ''}` : (r.asset?.address ?? '—')}</dd>
            <dt>Contact</dt>
            <dd>{r.contact?.name ?? '—'}</dd>
            <dt>Contact number</dt>
            <dd>{r.contactNumber ?? r.contact?.phone ?? '—'}</dd>
            <dt>Covered by</dt>
            <dd>
              <BasisBadge basis={r.chargeBasis} />{' '}
              {r.contract ? (
                <Link to={`/g-ops/service-contracts/${r.contract.id}`} className="mono">
                  {r.contract.number}
                </Link>
              ) : r.underWarranty ? (
                <span className="faint">under warranty</span>
              ) : null}
            </dd>
          </dl>
        </section>

        <section className="card">
          <h3 className="card-title">The service</h3>
          <dl className="kv">
            <dt>Service type</dt>
            <dd>{KIND_LABEL[r.kind] ?? r.kind}</dd>
            <dt>Priority</dt>
            <dd>{r.urgent ? <StatusBadge status="URGENT" extra={{ URGENT: 'danger' }} label="Urgent" /> : 'Normal'}</dd>
            <dt>Needed by</dt>
            <dd>{formatDate(r.neededBy)}</dd>
            <dt>Requested</dt>
            <dd>
              {formatDate(r.createdAt)} by {r.requestedBy.name}
            </dd>
            <dt>Team</dt>
            <dd>{r.team ? `${r.team.code} — ${r.team.name}` : '—'}</dd>
            <dt>Assigned engineer</dt>
            <dd>{r.assignedTo ? `${r.assignedTo.name}${r.assignedTo.team ? ` · ${r.assignedTo.team.code}` : ''}` : <span className="faint">to be assigned</span>}</dd>
            <dt>Customer PO</dt>
            <dd>{r.customerPoNumber ?? '—'}</dd>
            <dt>Amount</dt>
            <dd className="mono">{r.amount != null ? formatMoney(r.amount) : r.billable ? 'to be billed on completion' : '—'}</dd>
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
        <h3 className="card-title">Service visit</h3>
        {r.visit ? (
          <dl className="kv">
            <dt>Visit</dt>
            <dd>
              <Link to={`/g-ops/visits?visit=${r.visit.id}`} className="mono">
                {r.visit.number}
              </Link>{' '}
              <VisitBadge visit={{ status: r.visit.status, overdue: false }} />{' '}
              <span className="faint">
                {formatDate(r.visit.dueDate)} · {r.visit.slot}
              </span>
            </dd>
            <dt>Engineer</dt>
            <dd>{r.assignedTo?.name ?? <span className="faint">unassigned</span>}</dd>
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
          <p className="muted">{r.status === 'CANCELLED' ? 'No visit stands on a cancelled service JO.' : 'Booked on the needed-by day once the service JO is approved.'}</p>
        )}
      </section>

      <Attachments entityType="job_order" entityId={r.id} title="Photos and documents" hint="The customer’s email, the PO, pictures of the fault" canEdit={r.canEdit || r.status !== 'CANCELLED'} />

      {modal === 'edit' && (
        <ServiceJoModal
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
            await api.patch(`/service-job-orders/${r.id}/acknowledge`, { customerAcknowledgedBy: name });
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
      {modal === 'report' && r.visit && <NewReportModal preset={{ visitId: r.visit.id }} onClose={() => setModal(null)} onCreated={(reportId) => navigate(`/g-ops/service-reports/${reportId}`)} />}
    </div>
  );
}
