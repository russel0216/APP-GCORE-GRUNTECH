import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api, qs } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { DataList, type BulkContext, type Column, type FilterDef } from '../../components/DataList';
import { RecordHeader } from '../../components/RecordHeader';
import { useConfirm } from '../../components/Confirm';
import { Attachments, openAttachment, readableSize } from '../../components/Attachments';
import { Meter, Stat } from '../../components/charts';
import { NumberInput } from '../../components/NumberInput';
import { Icon } from '../../components/Icon';
import { ApiError } from '../../lib/api';
import {
  Avatar,
  Empty,
  ErrorBox,
  Field,
  Loading,
  Modal,
  ModalFoot,
  StatusBadge,
  formatDate,
  formatDateTime,
  useToast,
  type Tone,
} from '../../components/ui';

/**
 * CAD job orders — the design team's queue (2026-10-09, the owner's call).
 *
 * Sales, project managers and engineers ask the design team for a drawing:
 * a request for a customer, linked to the quotation, project or job order it
 * is for, with the scope in one box, the drawing type, the day it is needed
 * and the reference files. The Designer Lead assigns it (or a designer takes
 * it), the designer sets the priority and reports progress, and submits the
 * work as revisions — R0, R1, R2 — each with its files and a note, never
 * overwritten. The output is always a PDF. The requestor accepts, or asks
 * for changes in the thread, and the next revision answers. No approval
 * route; it is work, not a decision.
 */

export const CAD_TONES: Record<string, Tone> = {
  REQUESTED: 'info',
  IN_PROGRESS: 'info',
  FOR_REVIEW: 'warn',
  CHANGES_REQUESTED: 'warn',
  COMPLETED: 'ok',
  ON_HOLD: '',
  CANCELLED: '',
};

const PRIORITY_TONES: Record<string, Tone> = { URGENT: 'danger', HIGH: 'warn', NORMAL: 'info', LOW: '' };

const STATUSES = [
  { value: 'REQUESTED', label: 'Requested' },
  { value: 'IN_PROGRESS', label: 'In progress' },
  { value: 'FOR_REVIEW', label: 'For review' },
  { value: 'CHANGES_REQUESTED', label: 'Changes requested' },
  { value: 'COMPLETED', label: 'Completed' },
  { value: 'ON_HOLD', label: 'On hold' },
  { value: 'CANCELLED', label: 'Cancelled' },
];

const PRIORITIES = [
  { value: 'LOW', label: 'Low' },
  { value: 'NORMAL', label: 'Normal' },
  { value: 'HIGH', label: 'High' },
  { value: 'URGENT', label: 'Urgent' },
];

const priorityLabel = (p: string) => PRIORITIES.find((x) => x.value === p)?.label ?? p;
const statusLabel = (s: string) => STATUSES.find((x) => x.value === s)?.label ?? s;

/** What the file box accepts: the output PDF, the sources, pictures and archives. */
const FILE_ACCEPT = '.pdf,.dwg,.dxf,.dwt,.dwf,.skp,.layout,.rvt,.ifc,.stp,.step,.igs,.iges,.stl,.3ds,.obj,.fbx,.png,.jpg,.jpeg,.webp,.zip,.rar,.7z,.doc,.docx,.xls,.xlsx';

interface Person {
  id: string;
  name: string;
  position?: string | null;
}

interface FileRow {
  id: string;
  fileName: string;
  mimeType: string;
  size: number;
  uploadedAt: string;
  uploadedBy: { id: string; name: string } | null;
}

export interface CadRow {
  id: string;
  number: string;
  status: string;
  priority: string;
  progressPct: number;
  title: string;
  scope: string;
  neededBy: string | null;
  overdue: boolean;
  assignedAt: string | null;
  holdReason: string | null;
  cancelReason: string | null;
  cancelledAt: string | null;
  completedAt: string | null;
  completionNote: string | null;
  approvedPlanId: string | null;
  createdAt: string;
  updatedAt: string;
  customer: { id: string; code: string; name: string };
  job: { id: string; number: string; name: string; status: string } | null;
  quotation: { id: string; number: string; subject: string; outcome: string } | null;
  jobOrder: { id: string; number: string; projectName: string | null; title: string; status: string } | null;
  drawingType: { id: string; name: string } | null;
  requestedBy: Person;
  assignedTo: Person | null;
  completedBy: { id: string; name: string } | null;
  approvedPlan: { id: string; title: string; drawingNo: string | null; revision: string; status: string } | null;
  latestRevision: { sequence: number; label: string; submittedAt: string } | null;
  revisionCount: number;
  commentCount: number;
}

interface Revision {
  id: string;
  sequence: number;
  label: string;
  note: string;
  externalUrl: string | null;
  submittedAt: string;
  submittedBy: { id: string; name: string };
  files: FileRow[];
}

interface Comment {
  id: string;
  body: string;
  isChangeRequest: boolean;
  createdAt: string;
  author: { id: string; name: string; photoPath: string | null };
  revision: { id: string; sequence: number } | null;
  files: FileRow[];
}

interface CadDetail extends CadRow {
  canEdit: boolean;
  canTake: boolean;
  canAssign: boolean;
  canSetPriority: boolean;
  canProgress: boolean;
  canSubmitRevision: boolean;
  canAccept: boolean;
  canRequestChanges: boolean;
  canHold: boolean;
  canResume: boolean;
  canCancel: boolean;
  canComment: boolean;
  canFilePlan: boolean;
  isDesigner: boolean;
  isLead: boolean;
  revisions: Revision[];
  comments: Comment[];
}

interface CadSummary {
  open?: number;
  requested?: number;
  inProgress?: number;
  forReview?: number;
  onHold?: number;
  completed?: number;
  overdue?: number;
  unassigned?: number;
}

const DESIGN_RIGHT = 'gops.cad_job_orders.edit_all';

/** The people on the design team — everyone holding the design right. */
function useDesigners(): Person[] {
  const [rows, setRows] = useState<Person[]>([]);
  useEffect(() => {
    api
      .get<Person[]>(`/users/lookup${qs({ holding: DESIGN_RIGHT })}`)
      .then(setRows)
      .catch(() => setRows([]));
  }, []);
  return rows;
}

export function PriorityBadge({ priority }: { priority: string }) {
  return <StatusBadge status={priority} extra={PRIORITY_TONES} label={priorityLabel(priority)} />;
}

function FileChips({ files, link }: { files: FileRow[]; link?: string | null }) {
  const toast = useToast();
  if (!files.length && !link) return <span className="faint">no files</span>;
  return (
    <ul className="cad-files">
      {files.map((f) => (
        <li key={f.id}>
          <button
            type="button"
            className={`cad-file${f.mimeType === 'application/pdf' || /\.pdf$/i.test(f.fileName) ? ' pdf' : ''}`}
            title={`${f.fileName} · ${readableSize(f.size)} · ${f.uploadedBy?.name ?? 'someone'}, ${formatDateTime(f.uploadedAt)}`}
            onClick={() => void openAttachment(f).then((ok) => !ok && toast('error', 'That file could not be opened'))}
          >
            <Icon name={f.mimeType.startsWith('image/') ? 'image' : 'document'} size={14} />
            {f.fileName}
            <span className="cad-file-size">{readableSize(f.size)}</span>
          </button>
        </li>
      ))}
      {link && (
        <li>
          <a className="cad-file" href={link} target="_blank" rel="noopener noreferrer">
            <Icon name="document" size={14} />
            External file ↗
          </a>
        </li>
      )}
    </ul>
  );
}

// ── The list ────────────────────────────────────────────────────────────────

export function CadJobOrders() {
  const { can } = useAuth();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const designers = useDesigners();
  const [requestors, setRequestors] = useState<Person[]>([]);
  const [drawingTypes, setDrawingTypes] = useState<{ id: string; name: string }[]>([]);
  // `?new=1&customerId=&jobId=&quotationId=&jobOrderId=` — how a project, a
  // quotation or a job order starts one without retyping.
  const [raising, setRaising] = useState(() => params.get('new') === '1' && can('gops.cad_job_orders.create'));
  const [prefill] = useState(() => ({
    customerId: params.get('customerId') ?? undefined,
    jobId: params.get('jobId') ?? undefined,
    quotationId: params.get('quotationId') ?? undefined,
    jobOrderId: params.get('jobOrderId') ?? undefined,
  }));
  const designer = can(DESIGN_RIGHT) || can('gops.cad_job_orders.approve');

  useEffect(() => {
    api
      .get<Person[]>(`/users/lookup${qs({ holding: 'gops.cad_job_orders.create' })}`)
      .then(setRequestors)
      .catch(() => setRequestors([]));
    api
      .get<{ id: string; name: string }[]>('/reference/cad-drawing-types')
      .then(setDrawingTypes)
      .catch(() => setDrawingTypes([]));
  }, []);

  function closeRaising() {
    setRaising(false);
    if (params.has('new')) {
      const next = new URLSearchParams(params);
      for (const k of ['new', 'customerId', 'jobId', 'quotationId', 'jobOrderId']) next.delete(k);
      setParams(next, { replace: true });
    }
  }

  const columns: Column<CadRow>[] = [
    { key: 'number', label: 'Number', sortKey: 'number', width: '140px', render: (r) => <span className="mono">{r.number}</span> },
    {
      key: 'title',
      label: 'Drawing',
      render: (r) => (
        <div>
          <div>{r.title}</div>
          <div className="faint">
            {r.drawingType?.name ?? 'type not stated'}
            {r.latestRevision ? ` · ${r.latestRevision.label}` : ''}
          </div>
        </div>
      ),
    },
    {
      key: 'customer',
      label: 'Customer / project',
      render: (r) => (
        <div>
          <div>{r.customer.name}</div>
          <div className="faint">{r.job ? `${r.job.number} — ${r.job.name}` : r.quotation ? r.quotation.number : r.jobOrder ? r.jobOrder.number : '—'}</div>
        </div>
      ),
    },
    {
      key: 'requestedBy',
      label: 'Requested by',
      sortKey: 'createdAt',
      render: (r) => (
        <div>
          <div>{r.requestedBy.name}</div>
          <div className="faint">{formatDate(r.createdAt)}</div>
        </div>
      ),
    },
    {
      key: 'designer',
      label: 'Designer',
      render: (r) => (r.assignedTo ? r.assignedTo.name : <span className="badge warn">Open</span>),
    },
    { key: 'priority', label: 'Priority', render: (r) => <PriorityBadge priority={r.priority} /> },
    {
      key: 'progress',
      label: 'Progress',
      sortKey: 'progressPct',
      width: '130px',
      render: (r) => <Meter pct={r.progressPct} tone={r.status === 'COMPLETED' ? 'ok' : undefined} />,
    },
    {
      key: 'neededBy',
      label: 'Needed by',
      sortKey: 'neededBy',
      render: (r) =>
        r.neededBy ? (
          <span className={r.overdue ? 'badge danger' : undefined}>
            {formatDate(r.neededBy)}
            {r.overdue ? ' · overdue' : ''}
          </span>
        ) : (
          <span className="faint">—</span>
        ),
    },
    { key: 'status', label: 'Status', render: (r) => <StatusBadge status={r.status} extra={CAD_TONES} label={statusLabel(r.status)} /> },
  ];

  const filters: FilterDef[] = [
    { key: 'status', label: 'Status', options: STATUSES },
    { key: 'priority', label: 'Priority', options: PRIORITIES },
    {
      key: 'open',
      label: 'Open',
      options: [{ value: 'true', label: 'Open — not completed or cancelled' }],
    },
    { key: 'overdue', label: 'Overdue', options: [{ value: 'true', label: 'Past its needed-by day' }] },
    { key: 'unassigned', label: 'Designer not yet assigned', options: [{ value: 'true', label: 'Waiting for a designer' }] },
    { key: 'drawingTypeId', label: 'Drawing type', options: drawingTypes.map((t) => ({ value: t.id, label: t.name })) },
    {
      key: 'assignedToId',
      label: 'Designer',
      options: [...designers.map((p) => ({ value: p.id, label: p.name })), { value: 'none', label: 'Open (no designer)' }],
    },
    { key: 'requestedById', label: 'Requested by', options: requestors.map((p) => ({ value: p.id, label: p.name })) },
    { key: 'neededFrom', toKey: 'neededTo', label: 'Needed by', type: 'dateRange' },
  ];

  const canCreate = can('gops.cad_job_orders.create');
  const lead = can('gops.cad_job_orders.approve');

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>CAD J.O.</h1>
        </div>
      </div>

      <DataList<CadRow>
        listKey="cad-job-orders"
        endpoint="/cad-job-orders"
        columns={columns}
        rowKey={(r) => r.id}
        rowLabel={(r) => `Select ${r.number}`}
        scoped
        defaultScope={designer ? 'all' : 'mine'}
        selectable
        printPath="/api/cad-job-orders/pdf"
        onRowClick={(r) => navigate(`/g-ops/cad-job-orders/${r.id}`)}
        searchPlaceholder="Search number, drawing, customer, project…"
        emptyTitle="No CAD job orders yet"
        emptyHint="Ask the design team for a drawing: the request, its reference files and the day it is needed."
        filters={filters}
        summary={(raw) => {
          const s = raw as CadSummary;
          return (
            <>
              <Stat label="Open" value={s.open ?? 0} />
              <Stat label="Waiting for a designer" value={s.unassigned ?? 0} accent={s.unassigned ? 'warn' : undefined} />
              <Stat label="In progress" value={s.inProgress ?? 0} />
              <Stat label="For review" value={s.forReview ?? 0} sub="drawings awaiting the requestor" />
              <Stat label="Overdue" value={s.overdue ?? 0} accent={s.overdue ? 'danger' : undefined} />
              <Stat label="Completed" value={s.completed ?? 0} />
            </>
          );
        }}
        bulkActions={lead ? (ctx) => <CadBulkActions ctx={ctx} designers={designers} /> : undefined}
        actions={
          canCreate ? (
            <button type="button" className="btn btn-primary btn-sm" onClick={() => setRaising(true)}>
              + New CAD J.O.
            </button>
          ) : null
        }
      />

      {raising && (
        <CadRequestModal
          prefill={prefill}
          onClose={closeRaising}
          onSaved={(id) => {
            setRaising(false);
            navigate(`/g-ops/cad-job-orders/${id}`);
          }}
        />
      )}
    </div>
  );
}

/**
 * The Designer Lead's mass actions: hand the ticked requests to a designer,
 * or set their priority — each the ordinary call per row, so the audit row
 * and the notifications are the route's. What did not change stays ticked.
 */
function CadBulkActions({ ctx, designers }: { ctx: BulkContext<CadRow>; designers: Person[] }) {
  const toast = useToast();
  const [action, setAction] = useState('');
  const [progress, setProgress] = useState<{ done: number; of: number } | null>(null);
  const [refused, setRefused] = useState<{ number: string; why: string }[]>([]);

  const designer = action.startsWith('assign:') ? designers.find((p) => p.id === action.slice(7)) ?? null : null;
  const priority = action.startsWith('priority:') ? action.slice(9) : null;
  const open = (r: CadRow) => r.status !== 'COMPLETED' && r.status !== 'CANCELLED';
  const plan = !action
    ? null
    : {
        go: ctx.rows.filter((r) => open(r) && (designer ? r.assignedTo?.id !== designer.id : r.priority !== priority)),
        stay: ctx.rows
          .filter((r) => !open(r) || (designer ? r.assignedTo?.id === designer.id : r.priority === priority))
          .map((r) => ({ row: r, why: !open(r) ? 'closed' : designer ? `already with ${designer.name}` : `already ${priorityLabel(priority!).toLowerCase()}` })),
      };

  async function apply() {
    if (!plan || !plan.go.length) return;
    const failed: { row: CadRow; why: string }[] = [];
    let done = 0;
    setRefused([]);
    for (let i = 0; i < plan.go.length; i++) {
      setProgress({ done: i, of: plan.go.length });
      const row = plan.go[i];
      try {
        if (designer) await api.post(`/cad-job-orders/${row.id}/assign`, { userId: designer.id });
        else await api.post(`/cad-job-orders/${row.id}/priority`, { priority });
        done++;
      } catch (err) {
        failed.push({ row, why: err instanceof ApiError ? err.message : 'could not be changed' });
      }
    }
    setProgress(null);
    const left = [...plan.stay, ...failed];
    toast(done > 0 ? 'ok' : 'error', `${done} request${done === 1 ? '' : 's'} ${designer ? `handed to ${designer.name}` : `set to ${priorityLabel(priority!).toLowerCase()} priority`}${left.length ? `; ${left.length} unchanged` : ''}`);
    setRefused(left.map((l) => ({ number: l.row.number, why: l.why })));
    setAction('');
    ctx.reload();
    if (left.length) ctx.keep(left.map((l) => l.row.id));
    else ctx.clear();
  }

  return (
    <>
      <select
        aria-label="Assign a designer, or set the priority, of the selected requests"
        value={action}
        disabled={!!progress}
        onChange={(e) => {
          setAction(e.target.value);
          setRefused([]);
        }}
      >
        <option value="">Assign designer or set priority…</option>
        <optgroup label="Assign to">
          {designers.map((p) => (
            <option key={p.id} value={`assign:${p.id}`}>
              {p.name}
            </option>
          ))}
        </optgroup>
        <optgroup label="Set priority">
          {PRIORITIES.map((p) => (
            <option key={p.value} value={`priority:${p.value}`}>
              {p.label}
            </option>
          ))}
        </optgroup>
      </select>
      {plan && (
        <button type="button" className="btn btn-sm btn-primary" disabled={!plan.go.length || !!progress} onClick={() => void apply()}>
          {progress
            ? `Working ${progress.done + 1} of ${progress.of}…`
            : plan.go.length
              ? designer
                ? `Hand ${plan.go.length} to ${designer.name}`
                : `Set ${plan.go.length} to ${priorityLabel(priority!).toLowerCase()}`
              : 'Nothing to change'}
        </button>
      )}
      {plan && plan.stay.length > 0 && !progress && (
        <p className="list-bulk-result">
          {plan.stay.length} will stay as they are: {plan.stay.slice(0, 6).map((st) => `${st.row.number} (${st.why})`).join(', ')}
          {plan.stay.length > 6 ? `, and ${plan.stay.length - 6} more` : ''}.
        </p>
      )}
      {!plan && refused.length > 0 && (
        <div className="list-bulk-result" role="status">
          Still selected — these did not change:
          <ul>
            {refused.map((r) => (
              <li key={r.number}>
                <span className="mono">{r.number}</span>: {r.why}
              </li>
            ))}
          </ul>
        </div>
      )}
    </>
  );
}

// ── Raising and editing ─────────────────────────────────────────────────────

interface Options {
  drawingTypes: { id: string; name: string }[];
  quotations: { id: string; number: string; subject: string; outcome: string }[];
  jobs: { id: string; number: string; name: string; status: string }[];
  jobOrders: { id: string; number: string; projectName: string | null; title: string; status: string; quotationId: string | null; jobId: string | null }[];
}

const NO_OPTIONS: Options = { drawingTypes: [], quotations: [], jobs: [], jobOrders: [] };

export function CadRequestModal({
  prefill,
  existing,
  onClose,
  onSaved,
}: {
  prefill?: { customerId?: string; jobId?: string; quotationId?: string; jobOrderId?: string };
  existing?: CadRow;
  onClose: () => void;
  onSaved: (id: string) => void;
}) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [customers, setCustomers] = useState<{ id: string; name: string }[]>([]);
  const [options, setOptions] = useState<Options>(NO_OPTIONS);
  const [drawingTypes, setDrawingTypes] = useState<{ id: string; name: string }[]>([]);

  const [form, setForm] = useState(() => ({
    customerId: existing?.customer.id ?? prefill?.customerId ?? '',
    jobId: existing?.job?.id ?? prefill?.jobId ?? '',
    quotationId: existing?.quotation?.id ?? prefill?.quotationId ?? '',
    jobOrderId: existing?.jobOrder?.id ?? prefill?.jobOrderId ?? '',
    drawingTypeId: existing?.drawingType?.id ?? '',
    title: existing?.title ?? '',
    scope: existing?.scope ?? '',
    neededBy: existing?.neededBy?.slice(0, 10) ?? '',
  }));
  const set = <K extends keyof typeof form>(k: K, v: (typeof form)[K]) => setForm((f) => ({ ...f, [k]: v }));

  useEffect(() => {
    api
      .get<{ customers: { id: string; name: string }[]; drawingTypes: { id: string; name: string }[] }>('/cad-job-orders/options')
      .then((d) => {
        setCustomers(d.customers);
        setDrawingTypes(d.drawingTypes);
      })
      .catch(() => setCustomers([]));
  }, []);

  useEffect(() => {
    if (!form.customerId) {
      setOptions(NO_OPTIONS);
      return;
    }
    api
      .get<Options>(`/cad-job-orders/options${qs({ customerId: form.customerId })}`)
      .then(setOptions)
      .catch(() => setOptions(NO_OPTIONS));
  }, [form.customerId]);

  /** Linking a job order fills the quotation and project it carries; its name is a fair title. */
  function pickJobOrder(id: string) {
    const jo = options.jobOrders.find((x) => x.id === id);
    setForm((f) => ({
      ...f,
      jobOrderId: id,
      quotationId: f.quotationId || jo?.quotationId || '',
      jobId: f.jobId || jo?.jobId || '',
      title: f.title || (jo ? `${jo.projectName ?? jo.title}` : ''),
    }));
  }

  async function save() {
    setBusy(true);
    setError(null);
    const body = {
      jobId: form.jobId || null,
      quotationId: form.quotationId || null,
      jobOrderId: form.jobOrderId || null,
      drawingTypeId: form.drawingTypeId || null,
      title: form.title.trim(),
      scope: form.scope.trim(),
      neededBy: form.neededBy || null,
    };
    try {
      if (existing) {
        await api.patch(`/cad-job-orders/${existing.id}`, body);
        toast('ok', 'Request updated');
        onSaved(existing.id);
      } else {
        const created = await api.post<{ id: string; number: string }>('/cad-job-orders', { customerId: form.customerId, ...body });
        toast('ok', `${created.number} raised — the design team has been told`);
        onSaved(created.id);
      }
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  }

  const types = existing?.drawingType && !drawingTypes.some((t) => t.id === existing.drawingType!.id) ? [existing.drawingType, ...drawingTypes] : drawingTypes;

  return (
    <Modal
      title={existing ? `Modify CAD job order ${existing.number}` : 'New CAD job order'}
      onClose={onClose}
      wide
      footer={
        <ModalFoot onCancel={onClose} busy={busy}>
          <button
            type="button"
            className="btn btn-primary"
            onClick={save}
            disabled={busy || !form.customerId || form.title.trim().length < 3 || form.scope.trim().length < 5}
          >
            {busy ? 'Saving…' : 'Save'}
          </button>
        </ModalFoot>
      }
    >
      <ErrorBox error={error} />

      <h4 className="svc-subhead">Links</h4>
      <div className="grid grid-2">
        <Field label="Customer">
          <select
            value={form.customerId}
            disabled={!!existing || !!prefill?.customerId}
            onChange={(e) => setForm({ ...form, customerId: e.target.value, jobId: '', quotationId: '', jobOrderId: '' })}
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
        <Field label="Project" hint="When the drawing is for a project already built">
          <select value={form.jobId} onChange={(e) => set('jobId', e.target.value)}>
            <option value="">— none —</option>
            {existing?.job && !options.jobs.some((j) => j.id === existing.job!.id) && <option value={existing.job.id}>{existing.job.number}</option>}
            {options.jobs.map((j) => (
              <option key={j.id} value={j.id}>
                {j.number} — {j.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Quotation" hint="The quote the drawing supports, if any">
          <select value={form.quotationId} onChange={(e) => set('quotationId', e.target.value)}>
            <option value="">— none —</option>
            {existing?.quotation && !options.quotations.some((q) => q.id === existing.quotation!.id) && (
              <option value={existing.quotation.id}>{existing.quotation.number}</option>
            )}
            {options.quotations.map((q) => (
              <option key={q.id} value={q.id}>
                {q.number} — {q.subject}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Job order" hint="The project work order, if one was raised">
          <select value={form.jobOrderId} onChange={(e) => pickJobOrder(e.target.value)}>
            <option value="">— none —</option>
            {existing?.jobOrder && !options.jobOrders.some((o) => o.id === existing.jobOrder!.id) && (
              <option value={existing.jobOrder.id}>{existing.jobOrder.number}</option>
            )}
            {options.jobOrders.map((o) => (
              <option key={o.id} value={o.id}>
                {o.number} — {o.projectName ?? o.title}
              </option>
            ))}
          </select>
        </Field>
      </div>

      <h4 className="svc-subhead">The drawing</h4>
      <div className="grid grid-2">
        <Field label="Drawing type">
          <select value={form.drawingTypeId} onChange={(e) => set('drawingTypeId', e.target.value)}>
            <option value="">— not stated —</option>
            {types.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Needed by" hint="The design team sets the priority; the date says when you need it">
          <input type="date" value={form.neededBy} onChange={(e) => set('neededBy', e.target.value)} />
        </Field>
      </div>
      <Field label="In one line">
        <input value={form.title} placeholder="Compressor room layout, Building B" onChange={(e) => set('title', e.target.value)} />
      </Field>
      <Field label="What the drawing should show" hint="The complete details: dimensions, equipment, references, the format the customer wants. Attach reference files on the request once it is raised.">
        <textarea rows={7} value={form.scope} onChange={(e) => set('scope', e.target.value)} />
      </Field>
    </Modal>
  );
}

// ── One request ─────────────────────────────────────────────────────────────

export function CadJobOrderDetail() {
  const { id } = useParams<{ id: string }>();
  const { can, me } = useAuth();
  const toast = useToast();
  const designers = useDesigners();
  const confirm = useConfirm();
  const [row, setRow] = useState<CadDetail | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  /** The in-page panels that gather more than a word (a designer; a revision's files and note; a plan's title and number), and the Modify form. */
  const [panel, setPanel] = useState<'edit' | 'assign' | 'revision' | 'plan' | null>(null);
  const [assignee, setAssignee] = useState('');
  const [pct, setPct] = useState('');

  const load = useCallback(async () => {
    if (!id) return;
    try {
      const data = await api.get<CadDetail>(`/cad-job-orders/${id}`);
      setRow(data);
      setPct(String(data.progressPct));
      setAssignee(data.assignedTo?.id ?? '');
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

  async function run(label: string, fn: () => Promise<unknown>, close = true) {
    setBusy(true);
    try {
      await fn();
      toast('ok', label);
      if (close) setPanel(null);
      await load();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  /** A step asked in the confirm bar: it throws, so a refusal shows in the bar and the bar stays open. */
  async function step(label: string, fn: () => Promise<unknown>) {
    await fn();
    toast('ok', label);
    setPanel(null);
    await load();
  }

  if (loading) return <Loading />;
  if (!row) return <ErrorBox error={error ?? new Error('CAD job order not found')} />;

  const r = row;
  const requestor = me?.user.id === r.requestedBy.id;
  const latest = r.revisions[0] ?? null;
  const latestLabel = latest?.label ?? 'the drawing';
  const nextLabel = latest ? `R${latest.sequence + 1}` : 'R0';
  // The one main next step, when there is one: take it, accept it, file it, resume it, give it a designer, or submit the next revision.
  const main = r.canTake
    ? 'take'
    : r.canAccept
      ? 'accept'
      : r.canFilePlan
        ? 'plan'
        : r.canResume
          ? 'resume'
          : r.canAssign && !r.assignedTo
            ? 'assign'
            : r.canSubmitRevision
              ? 'revision'
              : null;
  const btn = (key: string) => (main === key ? 'btn btn-primary' : 'btn');

  return (
    <div>
      <RecordHeader
        type="CAD Job Order"
        code={r.number}
        title={r.title}
        status={r.status}
        statusExtra={CAD_TONES}
        statusLabel={statusLabel(r.status)}
        meta={
          <>
            {r.customer.name} · requested by {r.requestedBy.name} on {formatDate(r.createdAt)}
            {r.neededBy ? ` · needed by ${formatDate(r.neededBy)}` : ''}
            {r.assignedTo ? ` · with ${r.assignedTo.name}` : ' · no designer yet'}
            {r.completedAt ? ` · completed ${formatDate(r.completedAt)}` : ''}
          </>
        }
        actions={
          <>
            {r.canTake && (
              <button type="button" className={btn('take')} disabled={busy} onClick={() => run('It is on your board', () => api.post(`/cad-job-orders/${r.id}/take`))}>
                Take this request
              </button>
            )}
            {r.canAssign && (
              <button type="button" className={btn('assign')} aria-expanded={panel === 'assign'} onClick={() => setPanel(panel === 'assign' ? null : 'assign')} disabled={busy}>
                {r.assignedTo ? 'Reassign' : 'Assign designer'}
              </button>
            )}
            {r.canSubmitRevision && (
              <button type="button" className={btn('revision')} aria-expanded={panel === 'revision'} onClick={() => setPanel(panel === 'revision' ? null : 'revision')} disabled={busy}>
                Submit {nextLabel}
              </button>
            )}
            {r.canAccept && (
              <button
                type="button"
                className={btn('accept')}
                disabled={busy}
                onClick={() =>
                  confirm.ask({
                    title: requestor ? `Accept ${latestLabel}?` : `Close ${r.number} with ${latestLabel}?`,
                    body: requestor
                      ? 'The request is completed with this revision, and the designer is told.'
                      : 'The request is completed without the requestor’s acceptance, and they are told.',
                    confirmLabel: 'Accept and complete',
                    reason: requestor ? 'optional' : 'required',
                    reasonLabel: requestor ? 'A note, if any' : 'Why is it being closed without the requestor’s acceptance?',
                    tone: 'primary',
                    onConfirm: (note) => step('Completed', () => api.post(`/cad-job-orders/${r.id}/accept`, { note: note || null })),
                  })
                }
              >
                Accept {latest?.label ?? ''}
              </button>
            )}
            {r.canRequestChanges && (
              <button
                type="button"
                className="btn"
                disabled={busy}
                onClick={() =>
                  confirm.ask({
                    title: `Ask for changes to ${latestLabel}?`,
                    body: 'Goes into the thread; the designer is told and the next revision answers it.',
                    confirmLabel: 'Request changes',
                    reason: 'required',
                    minReason: 3,
                    reasonLabel: 'What should change?',
                    tone: 'primary',
                    onConfirm: (comment) => step('Changes requested', () => api.post(`/cad-job-orders/${r.id}/changes`, { comment })),
                  })
                }
              >
                Request changes
              </button>
            )}
            {r.canResume && (
              <button type="button" className={btn('resume')} disabled={busy} onClick={() => run('Resumed', () => api.post(`/cad-job-orders/${r.id}/resume`))}>
                Resume
              </button>
            )}
            {r.canFilePlan && (
              <button type="button" className={btn('plan')} aria-expanded={panel === 'plan'} onClick={() => setPanel(panel === 'plan' ? null : 'plan')} disabled={busy}>
                File as Approved Plan
              </button>
            )}
          </>
        }
        print={`/api/cad-job-orders/${r.id}/pdf`}
        more={[
          r.canHold && {
            label: 'Put on hold',
            confirm: {
              title: `Put ${r.number} on hold?`,
              body: 'Waiting on the customer, on a site measurement, on a decision… Resume picks it up where it stopped.',
              confirmLabel: 'Put on hold',
              reason: 'required',
              minReason: 3,
              reasonLabel: 'Why?',
              tone: 'primary',
              onConfirm: (reason) => step('On hold', () => api.post(`/cad-job-orders/${r.id}/hold`, { reason })),
            },
          },
          r.canCancel && {
            label: 'Cancel CAD job order',
            danger: true,
            confirm: {
              title: `Cancel ${r.number}?`,
              body: 'The requestor and the designer are told. A cancelled request is kept as a record.',
              confirmLabel: 'Cancel CAD job order',
              reason: 'required',
              minReason: 3,
              reasonLabel: 'Why is it cancelled?',
              onConfirm: (reason) => step('Request cancelled', () => api.post(`/cad-job-orders/${r.id}/cancel`, { reason })),
            },
          },
        ]}
        modify={r.canEdit ? () => setPanel('edit') : undefined}
        confirm={confirm}
      />

      <ErrorBox error={error} />

      {r.overdue && <div className="alert warn">Past the day it was needed by, {formatDate(r.neededBy!)}, and still open.</div>}
      {r.status === 'REQUESTED' && !r.assignedTo && (
        <div className="alert info">Waiting for a designer: the Designer Lead assigns it, or a designer takes it from the queue.</div>
      )}
      {r.status === 'FOR_REVIEW' && latest && (
        <div className="alert info">
          {latest.label} is ready for review{requestor ? ' — accept it, or ask for changes' : ` — waiting on ${r.requestedBy.name}`}.
        </div>
      )}
      {r.status === 'CHANGES_REQUESTED' && <div className="alert warn">Changes were requested — see the thread. The next revision answers them.</div>}
      {r.status === 'ON_HOLD' && <div className="alert warn">On hold: {r.holdReason ?? 'no reason recorded'}</div>}
      {r.status === 'CANCELLED' && (
        <div className="alert warn">
          Cancelled{r.cancelledAt ? ` on ${formatDate(r.cancelledAt)}` : ''}: {r.cancelReason ?? 'no reason recorded'}
        </div>
      )}
      {r.status === 'COMPLETED' && (
        <div className="alert ok">
          {r.completedBy?.id === r.requestedBy.id ? 'Accepted' : 'Closed'} by {r.completedBy?.name ?? 'someone'}
          {r.completedAt ? ` on ${formatDate(r.completedAt)}` : ''}
          {r.completionNote ? `: ${r.completionNote}` : ''}
          {r.approvedPlan && r.job ? (
            <>
              {' '}
              · filed as approved plan {r.approvedPlan.drawingNo ?? r.approvedPlan.title} {r.approvedPlan.revision} on{' '}
              <Link to={`/g-ops/projects/${r.job.id}?tab=plans`}>{r.job.number}</Link>
            </>
          ) : null}
        </div>
      )}

      {panel === 'assign' && r.canAssign && (
        <div className="cad-panel" role="group" aria-label="Assign a designer">
          <h4 className="svc-subhead" style={{ marginTop: 0 }}>
            Assign a designer
          </h4>
          <Field label="Designer" hint="Everyone holding the design right. Choose nobody to put it back in the queue.">
            <select value={assignee} onChange={(e) => setAssignee(e.target.value)}>
              <option value="">— back to the queue —</option>
              {designers.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                  {p.position ? ` — ${p.position}` : ''}
                </option>
              ))}
            </select>
          </Field>
          <div className="cad-panel-actions">
            <button type="button" className="btn" onClick={() => setPanel(null)} disabled={busy}>
              Cancel
            </button>
            <button
              type="button"
              className="btn btn-primary"
              disabled={busy || assignee === (r.assignedTo?.id ?? '')}
              onClick={() => run(assignee ? 'Assigned' : 'Back in the queue', () => api.post(`/cad-job-orders/${r.id}/assign`, { userId: assignee || null }))}
            >
              {assignee ? 'Assign' : 'Unassign'}
            </button>
          </div>
        </div>
      )}
      {panel === 'revision' && r.canSubmitRevision && <SubmitRevisionPanel row={r} next={nextLabel} busy={busy} onClose={() => setPanel(null)} onRun={run} />}
      {panel === 'plan' && r.canFilePlan && <FilePlanPanel row={r} busy={busy} onClose={() => setPanel(null)} onRun={run} />}

      <div className="svc-detail-grid">
        <section className="card">
          <h3 className="card-title">The request</h3>
          <dl className="kv">
            <dt>Drawing type</dt>
            <dd>{r.drawingType?.name ?? <span className="faint">not stated</span>}</dd>
            <dt>Customer</dt>
            <dd>{can('gops.customers.view_all') ? <Link to={`/g-ops/customers/${r.customer.id}`}>{r.customer.name}</Link> : r.customer.name}</dd>
            <dt>Project</dt>
            <dd>
              {r.job ? (
                <>
                  {can('gops.projects.view_all') ? (
                    <Link to={`/g-ops/projects/${r.job.id}`} className="mono">
                      {r.job.number}
                    </Link>
                  ) : (
                    <span className="mono">{r.job.number}</span>
                  )}{' '}
                  <span className="faint">{r.job.name}</span>
                </>
              ) : (
                '—'
              )}
            </dd>
            <dt>Quotation</dt>
            <dd>
              {r.quotation ? (
                <>
                  {can('gops.quotations.view_all') || can('gops.quotations.view_own') ? (
                    <Link to={`/g-ops/quotations/${r.quotation.id}`} className="mono">
                      {r.quotation.number}
                    </Link>
                  ) : (
                    <span className="mono">{r.quotation.number}</span>
                  )}{' '}
                  <span className="faint">{r.quotation.subject}</span>
                </>
              ) : (
                '—'
              )}
            </dd>
            <dt>Job order</dt>
            <dd>
              {r.jobOrder ? (
                <>
                  {can('gops.job_orders.view_all') || can('gops.job_orders.view_own') ? (
                    <Link to={`/g-ops/job-orders/${r.jobOrder.id}`} className="mono">
                      {r.jobOrder.number}
                    </Link>
                  ) : (
                    <span className="mono">{r.jobOrder.number}</span>
                  )}{' '}
                  <span className="faint">{r.jobOrder.projectName ?? r.jobOrder.title}</span>
                </>
              ) : (
                '—'
              )}
            </dd>
            <dt>Needed by</dt>
            <dd>{r.neededBy ? formatDate(r.neededBy) : <span className="faint">no date given</span>}</dd>
            <dt>Requested by</dt>
            <dd>
              {r.requestedBy.name}
              {r.requestedBy.position ? <span className="faint"> · {r.requestedBy.position}</span> : null}
            </dd>
          </dl>
        </section>

        <section className="card">
          <h3 className="card-title">Design team</h3>
          <dl className="kv">
            <dt>Designer</dt>
            <dd>
              {r.assignedTo ? (
                <>
                  {r.assignedTo.name}
                  {r.assignedAt && <span className="faint"> · since {formatDate(r.assignedAt)}</span>}
                </>
              ) : (
                <span className="badge warn">Open</span>
              )}
            </dd>
            <dt>Priority</dt>
            <dd>
              {r.canSetPriority ? (
                <select
                  aria-label="Priority"
                  value={r.priority}
                  disabled={busy}
                  onChange={(e) => run(`Priority set to ${priorityLabel(e.target.value).toLowerCase()}`, () => api.post(`/cad-job-orders/${r.id}/priority`, { priority: e.target.value }))}
                >
                  {PRIORITIES.map((p) => (
                    <option key={p.value} value={p.value}>
                      {p.label}
                    </option>
                  ))}
                </select>
              ) : (
                <PriorityBadge priority={r.priority} />
              )}
            </dd>
            <dt>Progress</dt>
            <dd>
              <div className="cad-progress">
                <Meter pct={r.progressPct} tone={r.status === 'COMPLETED' ? 'ok' : undefined} />
              </div>
              {r.canProgress && (
                <div className="cad-progress-edit">
                  <NumberInput kind="count" min={0} max={100} step={5} value={pct} onChange={(e) => setPct(e.target.value)} aria-label="Progress, percent" />
                  {[25, 50, 75, 100].map((n) => (
                    <button key={n} type="button" className="btn btn-sm" disabled={busy} onClick={() => setPct(String(n))}>
                      {n}%
                    </button>
                  ))}
                  <button
                    type="button"
                    className="btn btn-sm btn-primary"
                    disabled={busy || pct === '' || Number(pct) === r.progressPct}
                    onClick={() => run(`Progress ${pct}%`, () => api.post(`/cad-job-orders/${r.id}/progress`, { progressPct: Math.round(Number(pct)) }))}
                  >
                    Save progress
                  </button>
                </div>
              )}
            </dd>
            <dt>Revisions</dt>
            <dd>{r.revisionCount ? `${r.revisionCount} (latest ${latest?.label})` : <span className="faint">none yet</span>}</dd>
          </dl>
        </section>
      </div>

      <section className="card">
        <h3 className="card-title">What the drawing should show</h3>
        <p className="svc-text">{r.scope}</p>
      </section>

      <RevisionsCard row={r} />

      <ThreadCard row={r} busy={busy} onRun={run} />

      <Attachments
        entityType="cad_job_order"
        entityId={r.id}
        title="Reference files"
        hint="What the designer works from: site photos, sketches, the customer’s drawings, an existing DWG."
        canEdit={r.canEdit || r.isDesigner}
      />

      {panel === 'edit' && (
        <CadRequestModal
          existing={r}
          onClose={() => setPanel(null)}
          onSaved={() => {
            setPanel(null);
            void load();
          }}
        />
      )}
    </div>
  );
}

/**
 * The revisions, latest first. Submitting the next one, accepting the latest
 * or asking for changes to it are next steps in the page's header.
 */
function RevisionsCard({ row: r }: { row: CadDetail }) {
  return (
    <section className="card">
      <h3 className="card-title">
        Revisions
        {r.revisions.length ? <span className="badge">{r.revisions.length}</span> : null}
      </h3>
      {r.revisions.length === 0 ? (
        <Empty title="No revision submitted yet" hint={r.canSubmitRevision ? 'Submit the first one, R0, with its PDF.' : undefined} />
      ) : (
        <ul className="cad-revisions">
          {r.revisions.map((rev, i) => (
            <li key={rev.id} className={`cad-revision${i === 0 ? ' latest' : ''}`}>
              <div className="cad-revision-head">
                <span className="cad-rev">{rev.label}</span>
                {i === 0 && <span className="badge info">latest</span>}
                <span className="faint">
                  {rev.submittedBy.name}, {formatDateTime(rev.submittedAt)}
                </span>
              </div>
              <p className="cad-revision-note">{rev.note}</p>
              <FileChips files={rev.files} link={rev.externalUrl} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** The designer's "Submit Rn" panel, opened from the header: the PDF (and its source), a note, an optional link. */
function SubmitRevisionPanel({
  row: r,
  next,
  busy,
  onClose,
  onRun,
}: {
  row: CadDetail;
  next: string;
  busy: boolean;
  onClose: () => void;
  onRun: (label: string, fn: () => Promise<unknown>, close?: boolean) => Promise<void>;
}) {
  const [note, setNote] = useState('');
  const [externalUrl, setExternalUrl] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const hasPdf = files.some((f) => f.type === 'application/pdf' || /\.pdf$/i.test(f.name));

  async function submit() {
    const form = new FormData();
    form.set('note', note.trim());
    if (externalUrl.trim()) form.set('externalUrl', externalUrl.trim());
    for (const f of files) form.append('files', f);
    // A success closes the panel (the page's run()); a refusal keeps it open with the files still picked.
    await onRun(`${next} submitted — the requestor has been told`, () => api.post(`/cad-job-orders/${r.id}/revisions`, form));
  }

  return (
    <div className="cad-panel" role="group" aria-label={`Submit ${next}`}>
      <h4 className="svc-subhead" style={{ marginTop: 0 }}>
        Submit {next}
      </h4>
      <Field label="Files" hint="The PDF output is required — the requestor always receives a PDF. Add the AutoCAD or SketchUp source beside it; up to 20 files.">
        <input type="file" multiple accept={FILE_ACCEPT} onChange={(e) => setFiles([...(e.target.files ?? [])])} />
        {files.length > 0 && (
          <p className="cad-picked">
            {files.map((f) => f.name).join(', ')} · {readableSize(files.reduce((t, f) => t + f.size, 0))}
            {!hasPdf ? ' · no PDF yet' : ''}
          </p>
        )}
      </Field>
      <Field label="What this revision covers, or what changed" hint={r.revisions.length ? 'Say what changed since the last revision' : undefined}>
        <textarea rows={3} value={note} onChange={(e) => setNote(e.target.value)} />
      </Field>
      <Field label="External file link" hint="For a model too big to upload: a shared-drive link, http(s) only">
        <input value={externalUrl} placeholder="https://…" onChange={(e) => setExternalUrl(e.target.value)} />
      </Field>
      <div className="cad-panel-actions">
        <button type="button" className="btn" onClick={onClose} disabled={busy}>
          Cancel
        </button>
        <button type="button" className="btn btn-primary" disabled={busy || !hasPdf || note.trim().length < 2} onClick={() => void submit()}>
          {busy ? 'Uploading…' : `Submit ${next}`}
        </button>
      </div>
    </div>
  );
}

/** The thread between the requestor and the designer, and the composer. */
function ThreadCard({ row: r, busy, onRun }: { row: CadDetail; busy: boolean; onRun: (label: string, fn: () => Promise<unknown>, close?: boolean) => Promise<void> }) {
  const [body, setBody] = useState('');
  const [revisionId, setRevisionId] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const fileRef = useRef<HTMLInputElement | null>(null);

  async function post() {
    const form = new FormData();
    form.set('body', body.trim());
    if (revisionId) form.set('revisionId', revisionId);
    for (const f of files) form.append('files', f);
    await onRun('Posted', () => api.post(`/cad-job-orders/${r.id}/comments`, form));
    setBody('');
    setRevisionId('');
    setFiles([]);
    if (fileRef.current) fileRef.current.value = '';
  }

  return (
    <section className="card">
      <h3 className="card-title">
        Thread
        {r.comments.length ? <span className="badge">{r.comments.length}</span> : null}
      </h3>
      {r.comments.length === 0 ? (
        <Empty title="Nothing said yet" hint="Changes, clarifications and detail updates go here, and the other side is told." />
      ) : (
        <ul className="cad-thread">
          {r.comments.map((c) => (
            <li key={c.id} className={`cad-comment${c.isChangeRequest ? ' change' : ''}`}>
              <Avatar name={c.author.name} photoId={c.author.photoPath} size={32} />
              <div className="cad-comment-body">
                <div className="cad-comment-meta">
                  <strong>{c.author.name}</strong>
                  <span>{formatDateTime(c.createdAt)}</span>
                  {c.revision && <span className="badge">R{c.revision.sequence}</span>}
                  {c.isChangeRequest && <span className="badge warn">changes requested</span>}
                </div>
                <p className="cad-comment-text">{c.body}</p>
                {c.files.length > 0 && <FileChips files={c.files} />}
              </div>
            </li>
          ))}
        </ul>
      )}

      {r.canComment && (
        <div className="cad-compose">
          <Field label="Add to the thread">
            <textarea rows={3} value={body} placeholder="A change, a clarification, a detail update…" onChange={(e) => setBody(e.target.value)} />
          </Field>
          <div className="cad-compose-foot">
            <select aria-label="About which revision" value={revisionId} onChange={(e) => setRevisionId(e.target.value)}>
              <option value="">About the request</option>
              {r.revisions.map((rev) => (
                <option key={rev.id} value={rev.id}>
                  About {rev.label}
                </option>
              ))}
            </select>
            <input ref={fileRef} type="file" multiple accept={FILE_ACCEPT} aria-label="Files with the comment" onChange={(e) => setFiles([...(e.target.files ?? [])])} />
            <span className="spacer" />
            <button type="button" className="btn btn-primary btn-sm" disabled={busy || !body.trim()} onClick={() => void post()}>
              Post
            </button>
          </div>
        </div>
      )}
    </section>
  );
}

/** Files the accepted revision on the linked project's Approved Plans. */
function FilePlanPanel({
  row: r,
  busy,
  onClose,
  onRun,
}: {
  row: CadDetail;
  busy: boolean;
  onClose: () => void;
  onRun: (label: string, fn: () => Promise<unknown>, close?: boolean) => Promise<void>;
}) {
  const latest = r.revisions[0];
  const [title, setTitle] = useState(r.title);
  const [drawingNo, setDrawingNo] = useState(r.number);
  const [discipline, setDiscipline] = useState(r.drawingType?.name ?? '');
  return (
    <div className="cad-panel" role="group" aria-label="File as an approved plan">
      <h4 className="svc-subhead" style={{ marginTop: 0 }}>
        File {latest?.label ?? 'the drawing'} on {r.job?.number} as an approved plan
      </h4>
      <p className="muted">
        The revision’s files are copied onto the project’s Approved Plans, for approval there. The request keeps its own copy.
      </p>
      <div className="grid grid-3">
        <Field label="Plan title">
          <input value={title} onChange={(e) => setTitle(e.target.value)} />
        </Field>
        <Field label="Drawing number">
          <input className="mono" value={drawingNo} onChange={(e) => setDrawingNo(e.target.value)} />
        </Field>
        <Field label="Discipline">
          <input value={discipline} placeholder="Mechanical, Electrical, Civil…" onChange={(e) => setDiscipline(e.target.value)} />
        </Field>
      </div>
      <div className="cad-panel-actions">
        <button type="button" className="btn" onClick={onClose} disabled={busy}>
          Cancel
        </button>
        <button
          type="button"
          className="btn btn-primary"
          disabled={busy || title.trim().length < 2}
          onClick={() =>
            onRun('Filed on the project’s Approved Plans', () =>
              api.post(`/cad-job-orders/${r.id}/file-plan`, { title: title.trim(), drawingNo: drawingNo.trim() || null, discipline: discipline.trim() || null }),
            )
          }
        >
          File as Approved Plan
        </button>
      </div>
    </div>
  );
}
