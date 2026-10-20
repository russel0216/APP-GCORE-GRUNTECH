import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { DataList, type Column } from '../../components/DataList';
import { RecordHeader } from '../../components/RecordHeader';
import { useConfirm } from '../../components/Confirm';
import { useBackLink } from '../../components/Navigation';
import { ApprovalStepper, DocumentApproval, DecisionNote, allHeld, previewSteps } from '../../components/ApprovalStepper';
import { Attachments } from '../../components/Attachments';
import { Empty, ErrorBox, Field, Loading, Modal, ModalFoot, StatusBadge, formatDate, formatMoney, useToast, type Tone } from '../../components/ui';

/**
 * REQUEST FOR APPROVAL (2026-10-13, the owner's call: "replace the Approved
 * Plans with Request for Approval — a form with internal approval (Technical
 * Manager, Team Leader) and a drawing reference number, which could come
 * from a CAD J.O."); no CEO step since 2026-10-20.
 *
 * A project's drawing or document, raised as a draft with its files, sent
 * through the approval engine — never approved by hand — and decided on the
 * Approval panel of its own page. The register is the list across projects;
 * a project's tab lists its own. The API is `/api/plans` (the record keeps its
 * old table and keys, `gops.plans.*`).
 */

export const PLAN_TONES: Record<string, Tone> = {
  DRAFT: '',
  PENDING_APPROVAL: 'warn',
  APPROVED: 'ok',
  SUPERSEDED: '',
  REJECTED: 'danger',
  CANCELLED: 'danger',
  FOR_APPROVAL: 'warn',
};

export interface PlanRequest {
  id: string;
  number: string | null;
  title: string;
  description: string | null;
  drawingNo: string | null;
  revision: string;
  discipline: string | null;
  notes: string | null;
  status: string;
  amount: number | null;
  cancelReason: string | null;
  submittedAt: string | null;
  approvedAt: string | null;
  approvedBy: string | null;
  createdAt: string;
  reference: string;
  job: { id: string; number: string; name: string; contractValue: number; customer: { id: string; name: string } | null };
  requestedBy: { id: string; name: string };
  cadJobOrder: { id: string; number: string; title: string } | null;
  canEdit?: boolean;
  canSubmit?: boolean;
  canWithdraw?: boolean;
  canCancel?: boolean;
  canDelete?: boolean;
  /** The customer's answer, once the team approved it (2026-10-20). */
  customerDecision?: string | null;
  customerDecisionLabel?: string | null;
  customerName?: string | null;
  customerPosition?: string | null;
  customerDecidedOn?: string | null;
  customerRemarks?: string | null;
  customerRecordedAt?: string | null;
  customerRecordedBy?: { id: string; name: string } | null;
  canRecordCustomer?: boolean;
  approvalRoute?: { name: string; steps: { name: string; held?: boolean; approvers: { id: string; name: string }[] }[] } | null;
}

const STATUSES = [
  { value: 'DRAFT', label: 'Draft' },
  { value: 'PENDING_APPROVAL', label: 'Pending approval' },
  { value: 'APPROVED', label: 'Approved' },
  { value: 'SUPERSEDED', label: 'Superseded' },
  { value: 'CANCELLED', label: 'Cancelled' },
];

/** The register across every project — `GET /plans`, the same where-builder as its paper. */
export function PlanApprovalsRegister() {
  const navigate = useNavigate();
  const columns: Column<PlanRequest>[] = [
    { key: 'number', label: 'Number', sortKey: 'number', render: (r) => <span className="mono">{r.number ?? '—'}</span> },
    {
      key: 'title',
      label: 'Request',
      sortKey: 'title',
      render: (r) => (
        <>
          {r.title}
          {r.reference && <div className="faint">{r.reference}</div>}
        </>
      ),
    },
    {
      key: 'job',
      label: 'Project',
      render: (r) => (
        <>
          <span className="mono">{r.job.number}</span>
          <div className="faint">{r.job.name}</div>
        </>
      ),
    },
    { key: 'requestedBy', label: 'Requested by', render: (r) => r.requestedBy.name },
    { key: 'status', label: 'Status', sortKey: 'status', render: (r) => <StatusBadge status={r.status} extra={PLAN_TONES} /> },
    { key: 'approvedAt', label: 'Approved', render: (r) => (r.approvedAt ? formatDate(r.approvedAt) : '—') },
    { key: 'createdAt', label: 'Raised', sortKey: 'createdAt', render: (r) => formatDate(r.createdAt) },
  ];
  return (
    <div>
      <div className="page-head">
        <h1>Request for Approval</h1>
      </div>
      <DataList<PlanRequest>
        listKey="plan-approvals"
        endpoint="/plans"
        printPath="/api/plans/pdf"
        columns={columns}
        rowKey={(r) => r.id}
        scoped
        selectable
        searchPlaceholder="Search number, drawing reference, request, project…"
        onRowClick={(r) => navigate(`/g-ops/plans/${r.id}`)}
        emptyTitle="No requests for approval"
        emptyHint="Raise one from a project's Request for Approval tab, or from an accepted CAD J.O."
        filters={[{ key: 'status', label: 'Status', options: STATUSES }]}
      />
    </div>
  );
}

/** A project's own requests — the Request for Approval tab. */
export function ProjectPlanApprovalsCard({
  job,
  plans,
  onChanged,
}: {
  job: { id: string; number: string };
  plans: { id: string; number: string | null; title: string; drawingNo: string | null; revision: string; status: string; approvedAt: string | null; uploadedBy?: { name: string } | null }[];
  onChanged: () => void;
}) {
  const { can } = useAuth();
  const navigate = useNavigate();
  const [raising, setRaising] = useState(false);
  return (
    <section className="card">
      <div className="card-head">
        <h3 className="card-title">Request for Approval</h3>
        {can('gops.plans.create') && (
          <button className="btn btn-sm" onClick={() => setRaising(true)}>
            + New request for approval
          </button>
        )}
      </div>
      <p className="muted del-lede">
        A drawing or document sent for internal approval — the Technical Manager, then the Team Leader of the team
        handling the project. Work should not start on a drawing that is not approved.
      </p>
      {plans.length === 0 ? (
        <Empty title="No requests for approval yet" hint="Raise one with its drawing attached, or from an accepted CAD J.O." />
      ) : (
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>Number</th>
                <th>Request</th>
                <th>Drawing reference</th>
                <th>Requested by</th>
                <th>Status</th>
                <th>Approved</th>
              </tr>
            </thead>
            <tbody>
              {plans.map((p) => (
                <tr key={p.id}>
                  <td>
                    <Link className="mono" to={`/g-ops/plans/${p.id}`}>
                      {p.number ?? 'Draft'}
                    </Link>
                  </td>
                  <td>{p.title}</td>
                  <td className="mono">{[p.drawingNo, p.revision && p.revision !== '0' ? p.revision : null].filter(Boolean).join(' · ') || '—'}</td>
                  <td>{p.uploadedBy?.name ?? '—'}</td>
                  <td>
                    <StatusBadge status={p.status} extra={PLAN_TONES} />
                  </td>
                  <td>{p.approvedAt ? formatDate(p.approvedAt) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {raising && (
        <PlanRequestModal
          jobId={job.id}
          onClose={() => setRaising(false)}
          onSaved={(saved) => {
            setRaising(false);
            onChanged();
            navigate(`/g-ops/plans/${saved.id}`);
          }}
        />
      )}
    </section>
  );
}

interface CadOption {
  id: string;
  number: string;
  title: string;
  drawingType: string | null;
  revision: string | null;
}

/** "+ New request for approval" and Modify — a draft's own fields; the files go on its page. */
export function PlanRequestModal({
  jobId,
  existing,
  onClose,
  onSaved,
}: {
  jobId: string;
  existing?: PlanRequest;
  onClose: () => void;
  onSaved: (saved: PlanRequest) => void;
}) {
  const toast = useToast();
  const [cads, setCads] = useState<CadOption[]>([]);
  const [cadId, setCadId] = useState('');
  const [form, setForm] = useState({
    title: existing?.title ?? '',
    description: existing?.description ?? '',
    drawingNo: existing?.drawingNo ?? '',
    revision: existing && existing.revision !== '0' ? existing.revision : '',
    discipline: existing?.discipline ?? '',
    notes: existing?.notes ?? '',
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const set = (k: keyof typeof form, v: string) => setForm((f) => ({ ...f, [k]: v }));

  useEffect(() => {
    if (existing) return;
    api.get<CadOption[]>(`/plans/cad-options?jobId=${jobId}`).then(setCads).catch(() => setCads([]));
  }, [jobId, existing]);

  const cad = cads.find((c) => c.id === cadId) ?? null;

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const body = { ...form, title: form.title.trim() || cad?.title || '' };
      const saved = existing
        ? await api.put<PlanRequest>(`/plans/${existing.id}`, body)
        : await api.post<PlanRequest>('/plans', { ...body, jobId, cadJobOrderId: cadId || null });
      toast('ok', existing ? 'Saved' : `${saved.number} raised — attach the drawing, then submit it for approval`);
      onSaved(saved);
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  }

  const valid = (form.title.trim() || cad) && (form.title.trim().length >= 2 || cad);
  return (
    <Modal
      title={existing ? `Modify request ${existing.number ?? ''}`.trim() : 'New request for approval'}
      onClose={onClose}
      footer={
        <ModalFoot onCancel={onClose} busy={busy}>
          <button type="button" className="btn btn-primary" onClick={save} disabled={busy || !valid}>
            {busy ? 'Saving…' : 'Save'}
          </button>
        </ModalFoot>
      }
    >
      <ErrorBox error={error} />
      {!existing && cads.length > 0 && (
        <Field label="From a CAD J.O." hint="An accepted drawing of this project: its number becomes the drawing reference and its files are copied on.">
          <select value={cadId} onChange={(e) => setCadId(e.target.value)}>
            <option value="">— none, type the reference —</option>
            {cads.map((c) => (
              <option key={c.id} value={c.id}>
                {c.number} {c.revision ?? ''} — {c.title}
              </option>
            ))}
          </select>
        </Field>
      )}
      <Field label="What is to be approved" required={!cad}>
        <input value={form.title} onChange={(e) => set('title', e.target.value)} placeholder={cad?.title ?? 'e.g. Pump room layout'} maxLength={300} />
      </Field>
      <Field label="Description">
        <textarea rows={3} value={form.description} onChange={(e) => set('description', e.target.value)} placeholder="What the approvers are asked to decide, and anything they should know." />
      </Field>
      {!cad && (
        <div className="grid-2">
          <Field label="Drawing reference number">
            <input value={form.drawingNo} onChange={(e) => set('drawingNo', e.target.value)} placeholder="e.g. GT-M-101" maxLength={80} />
          </Field>
          <Field label="Revision">
            <input value={form.revision} onChange={(e) => set('revision', e.target.value)} placeholder="e.g. R1" maxLength={20} />
          </Field>
        </div>
      )}
      <Field label="Discipline">
        <input value={form.discipline} onChange={(e) => set('discipline', e.target.value)} placeholder={cad?.drawingType ?? 'Mechanical, electrical, civil…'} maxLength={80} />
      </Field>
      <Field label="Notes">
        <textarea rows={2} value={form.notes} onChange={(e) => set('notes', e.target.value)} />
      </Field>
    </Modal>
  );
}

/** `/g-ops/plans/:id` — where the approval notification lands. */
export function PlanApprovalPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const toast = useToast();
  const { can } = useAuth();
  const confirm = useConfirm();
  const [row, setRow] = useState<PlanRequest | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [reload, setReload] = useState(0);
  const [editing, setEditing] = useState(false);

  const projectSide = can('gops.projects.view_all') || can('gops.projects.view_own');
  useBackLink(row && projectSide ? `/g-ops/projects/${row.job.id}?tab=plans` : null, row && projectSide ? `${row.job.number} Request for Approval` : null);

  const load = useCallback(async () => {
    try {
      setRow(await api.get<PlanRequest>(`/plans/${id}`));
    } catch (err) {
      setError(err);
    }
  }, [id]);

  useEffect(() => {
    load();
  }, [load]);

  if (error && !row) return <ErrorBox error={error} />;
  if (!row) return <Loading />;

  const draft = row.status === 'DRAFT' || row.status === 'FOR_APPROVAL';
  const route = row.approvalRoute;
  const done = () => {
    setReload((r) => r + 1);
    load();
  };

  async function submit() {
    setError(null);
    try {
      await api.post(`/plans/${id}/submit`);
      toast('ok', allHeld(route) ? 'Approved — you hold every step' : 'Sent for approval');
      done();
    } catch (err) {
      setError(err);
    }
  }

  return (
    <div>
      <RecordHeader
        type="Request for Approval"
        code={row.number ?? 'Draft'}
        title={row.title}
        status={row.status}
        statusExtra={PLAN_TONES}
        amount={formatMoney(row.amount ?? row.job.contractValue)}
        amountLabel="Project contract value"
        meta={
          <>
            Requested by {row.requestedBy.name} on {formatDate(row.createdAt)} · for{' '}
            <Link to={`/g-ops/projects/${row.job.id}`} className="mono">
              {row.job.number}
            </Link>{' '}
            {row.job.name}
            {row.reference && <> · drawing {row.reference}</>}
            {row.cadJobOrder && (
              <>
                {' '}
                · from{' '}
                <Link to={`/g-ops/cad-job-orders/${row.cadJobOrder.id}`} className="mono">
                  {row.cadJobOrder.number}
                </Link>
              </>
            )}
          </>
        }
        actions={
          row.canSubmit ? (
            <button className="btn btn-primary" onClick={submit}>
              Submit for approval
            </button>
          ) : undefined
        }
        print={`/api/plans/${row.id}/pdf`}
        more={[
          row.canWithdraw && {
            label: 'Pull back to draft',
            confirm: {
              title: `Pull ${row.number} back?`,
              body: 'The approval request is withdrawn and its approvers are told. It comes back as a draft to change and send again.',
              confirmLabel: 'Pull it back',
              onConfirm: async () => {
                await api.post(`/plans/${row.id}/withdraw`);
                toast('ok', 'Back to draft');
                done();
              },
            },
          },
          row.canCancel && {
            label: 'Cancel request',
            danger: true,
            confirm: {
              title: `Cancel ${row.number ?? 'this request'}?`,
              body: row.status === 'PENDING_APPROVAL' ? 'The approval request is withdrawn with it, and the approvers are told.' : 'Nothing has been decided yet.',
              confirmLabel: 'Cancel request',
              reason: 'required',
              reasonLabel: 'Why? Kept on the request',
              minReason: 3,
              onConfirm: async (reason) => {
                await api.post(`/plans/${row.id}/cancel`, { reason });
                toast('ok', 'Cancelled');
                done();
              },
            },
          },
          row.canDelete && {
            label: 'Delete',
            danger: true,
            confirm: {
              title: `Delete ${row.number ?? 'this request'}?`,
              body: 'It goes for good, with its files. Its number is not reused.',
              confirmLabel: 'Delete',
              onConfirm: async () => {
                await api.del(`/plans/${row.id}`);
                toast('ok', 'Deleted');
                navigate(projectSide ? `/g-ops/projects/${row.job.id}?tab=plans` : '/g-ops/plans');
              },
            },
          },
        ]}
        modify={row.canEdit ? () => setEditing(true) : undefined}
        confirm={confirm}
      />

      {draft && route && route.steps.length > 0 && (
        <div className="qd-route">
          <span className="qd-route-label">{allHeld(route) ? 'No one else’s approval needed — you hold every step' : 'Submit for approval sends it to'}</span>
          <ApprovalStepper steps={previewSteps(route)} />
        </div>
      )}
      <DecisionNote documentType="plan_approval" documentId={row.id} reloadToken={reload} />
      {!draft && row.status !== 'CANCELLED' && <DocumentApproval documentType="plan_approval" documentId={row.id} reloadToken={reload} />}

      <ErrorBox error={error} />

      {draft && <div className="alert info">A draft. Attach the drawing or document below, then submit it for approval.</div>}
      {row.status === 'APPROVED' && (
        <div className="alert ok">
          Approved{row.approvedAt ? ` on ${formatDate(row.approvedAt)}` : ''}
          {row.approvedBy ? ` — last signed by ${row.approvedBy}` : ''}. Work may start on it.
        </div>
      )}
      {row.status === 'SUPERSEDED' && <div className="alert warn">Superseded — a later request on the same drawing reference was approved.</div>}
      {row.status === 'CANCELLED' && <div className="alert warn">Cancelled{row.cancelReason ? ` — ${row.cancelReason}` : ''}.</div>}

      <div className="stack">
      <section className="card">
        <h3 className="card-title">The request</h3>
        <dl className="kv">
          <dt>What is to be approved</dt>
          <dd>{row.title}</dd>
          {row.description && (
            <>
              <dt>Description</dt>
              <dd className="del-prose">{row.description}</dd>
            </>
          )}
          <dt>Drawing reference</dt>
          <dd>{row.drawingNo ?? '—'}</dd>
          <dt>Revision</dt>
          <dd>{row.revision && row.revision !== '0' ? row.revision : '—'}</dd>
          <dt>Discipline</dt>
          <dd>{row.discipline ?? '—'}</dd>
          <dt>Customer</dt>
          <dd>{row.job.customer?.name ?? '—'}</dd>
          {row.notes && (
            <>
              <dt>Notes</dt>
              <dd className="del-prose">{row.notes}</dd>
            </>
          )}
        </dl>
      </section>

      <Attachments
        entityType="approved_plan"
        entityId={row.id}
        title="Drawings and documents"
        hint={draft ? 'The drawing or document to be approved — printed behind the request.' : 'What the approvers were sent. Files change only on a draft.'}
        canEdit={!!row.canEdit}
      />

      {(row.status === 'APPROVED' || row.customerDecision) && <CustomerApprovalCard row={row} onSaved={setRow} />}
      </div>

      {editing && (
        <PlanRequestModal
          jobId={row.job.id}
          existing={row}
          onClose={() => setEditing(false)}
          onSaved={() => {
            setEditing(false);
            done();
          }}
        />
      )}
    </div>
  );
}

const CUSTOMER_DECISIONS = [
  { value: 'APPROVED', label: 'Approved' },
  { value: 'APPROVED_AS_NOTED', label: 'Approved as noted' },
  { value: 'REVISE', label: 'Revise and resubmit' },
];

/**
 * The customer's approval (2026-10-20, the owner's call): recorded on the
 * page once the team has approved the request — the decision, who at the
 * customer made it, their position, the day and their remarks — in the
 * card, never a dialog. No signature: the record, stamped with who entered
 * it and when, is the proof. The customer's own copy (a marked-up scan, an
 * email) files beside it and prints behind the request.
 */
function CustomerApprovalCard({ row, onSaved }: { row: PlanRequest; onSaved: (r: PlanRequest) => void }) {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Manila' });
  const [form, setForm] = useState({
    decision: row.customerDecision ?? 'APPROVED',
    name: row.customerName ?? '',
    position: row.customerPosition ?? '',
    decidedOn: row.customerDecidedOn?.slice(0, 10) ?? today,
    remarks: row.customerRemarks ?? '',
  });
  const recorded = !!row.customerDecision;

  async function save(clear = false) {
    setBusy(true);
    setError(null);
    try {
      const saved = await api.post<PlanRequest>(
        `/plans/${row.id}/customer`,
        clear
          ? { decision: null }
          : { decision: form.decision, name: form.name.trim(), position: form.position.trim() || null, decidedOn: form.decidedOn, remarks: form.remarks.trim() || null },
      );
      onSaved(saved);
      setOpen(false);
      toast('ok', clear ? 'The customer’s answer was cleared' : 'The customer’s answer is recorded');
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <section className="card">
        <div className="card-head">
          <h3 className="card-title">Customer approval</h3>
          {row.canRecordCustomer && !open && (
            <button type="button" className="btn btn-sm" onClick={() => setOpen(true)}>
              {recorded ? 'Change' : 'Record the customer’s answer'}
            </button>
          )}
        </div>
        {!open &&
          (recorded ? (
            <dl className="kv">
              <dt>Decision</dt>
              <dd>
                <StatusBadge
                  status={row.customerDecision!}
                  extra={{ APPROVED: 'ok', APPROVED_AS_NOTED: 'ok', REVISE: 'warn' }}
                  label={row.customerDecisionLabel ?? row.customerDecision!}
                />
              </dd>
              <dt>Decided by</dt>
              <dd>
                {row.customerName}
                {row.customerPosition ? `, ${row.customerPosition}` : ''}
              </dd>
              <dt>Date</dt>
              <dd>{row.customerDecidedOn ? formatDate(row.customerDecidedOn) : '—'}</dd>
              {row.customerRemarks && (
                <>
                  <dt>Remarks</dt>
                  <dd className="del-prose">{row.customerRemarks}</dd>
                </>
              )}
              <dt>Recorded</dt>
              <dd className="faint">
                {row.customerRecordedBy?.name ?? '—'}
                {row.customerRecordedAt ? `, ${new Date(row.customerRecordedAt).toLocaleString('en-PH', { timeZone: 'Asia/Manila' })}` : ''}
              </dd>
            </dl>
          ) : (
            <p className="faint">
              Pending — send the request to the customer and record their answer here. The name, date and time stand as the signature.
            </p>
          ))}
        {open && (
          <div className="stack">
            <ErrorBox error={error} />
            <div className="grid-2">
              <Field label="Decision" required>
                <select value={form.decision} onChange={(e) => setForm((f) => ({ ...f, decision: e.target.value }))}>
                  {CUSTOMER_DECISIONS.map((d) => (
                    <option key={d.value} value={d.value}>
                      {d.label}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Date decided" required>
                <input type="date" value={form.decidedOn} max={today} onChange={(e) => setForm((f) => ({ ...f, decidedOn: e.target.value }))} />
              </Field>
              <Field label="Name (at the customer)" required>
                <input value={form.name} maxLength={200} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} />
              </Field>
              <Field label="Position">
                <input value={form.position} maxLength={200} onChange={(e) => setForm((f) => ({ ...f, position: e.target.value }))} />
              </Field>
            </div>
            <Field label="Remarks" hint={form.decision === 'REVISE' ? 'Say what the customer asked to revise' : 'What the customer noted, if anything'}>
              <textarea rows={3} value={form.remarks} onChange={(e) => setForm((f) => ({ ...f, remarks: e.target.value }))} />
            </Field>
            <div className="card-foot">
              {recorded && (
                <button type="button" className="btn btn-sm btn-danger" disabled={busy} onClick={() => save(true)}>
                  Clear
                </button>
              )}
              <button type="button" className="btn btn-sm" disabled={busy} onClick={() => setOpen(false)}>
                Cancel
              </button>
              <button
                type="button"
                className="btn btn-sm btn-primary"
                disabled={busy || !form.name.trim() || (form.decision === 'REVISE' && !form.remarks.trim())}
                onClick={() => save()}
              >
                {busy ? 'Saving…' : 'Save'}
              </button>
            </div>
          </div>
        )}
      </section>
      <Attachments
        entityType="approved_plan_customer"
        entityId={row.id}
        title="Customer’s copy"
        hint="The page the customer marked, or their email — printed behind the request."
        canEdit={!!row.canRecordCustomer}
      />
    </>
  );
}
