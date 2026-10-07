import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, openPdf, type ListResult } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { DataList, type Column } from '../../components/DataList';
import { RecordHeader } from '../../components/RecordHeader';
import { ApprovalStepper, DocumentApproval } from '../../components/ApprovalStepper';
import { ErrorBox, Field, Loading, Modal, StatusBadge, formatDate, formatMoney, humanise, useToast, type Tone } from '../../components/ui';
import { NumberInput } from '../../components/NumberInput';
import { RecordPaymentModal, paymentLink } from '../finance/Receivables';
import { NewClaimModal, CLAIM_TONES } from '../finance/Expenses';

/**
 * Budget requests — PROJECT CASH (2026-10-07, the owner's call).
 *
 * "It is not about changing the total budget allocated for the project; it
 * is about requesting cash so that the project team can purchase something
 * without the need for a purchase requisition." The project's manager allows
 * it, finance approves and releases it in one voucher, the team spends it,
 * and whoever asked accounts for it with receipts — a liquidation filed in
 * Expenses that names the request. Nothing reaches the project's budget until
 * that liquidation is approved, and then only what was actually spent.
 *
 * Not a cash advance: that is the company's term for a personal loan to a
 * person. Same arithmetic, different document, its own liquidation days.
 */

/** APPROVED means finance owes a release — information, not a finished thing. */
export const BUDGET_REQUEST_TONES: Record<string, Tone> = {
  APPROVED: 'info',
  RELEASED: 'warn',
  REFUND_DUE: 'warn',
  LIQUIDATED: 'ok',
};

const STATUSES = [
  { value: 'DRAFT', label: 'Draft' },
  { value: 'PENDING_APPROVAL', label: 'Pending approval' },
  { value: 'APPROVED', label: 'Approved — awaiting release' },
  { value: 'RELEASED', label: 'Released — awaiting liquidation' },
  { value: 'REFUND_DUE', label: 'Unspent cash owed back' },
  { value: 'LIQUIDATED', label: 'Liquidated' },
  { value: 'REJECTED', label: 'Rejected' },
  { value: 'CANCELLED', label: 'Cancelled' },
];

interface Liquidation {
  id: string;
  number: string;
  status: string;
  total: number;
  claimDate: string;
  approvedAt: string | null;
}

export interface BudgetRequest {
  id: string;
  number: string;
  status: string;
  reason: string;
  notes: string | null;
  cancelReason: string | null;
  amount: number;
  amountReleased: number;
  amountSpent: number;
  amountRefunded: number;
  neededBy: string | null;
  releasedAt: string | null;
  liquidationDueDate: string | null;
  approvedAt: string | null;
  liquidatedAt: string | null;
  createdAt: string;
  requestedBy: { id: string; name: string; email: string; position: string | null };
  job: { id: string; number: string; name: string; projectManager: { id: string; name: string } | null };
  costCategory: { id: string; name: string };
  toRelease: number;
  spent: number;
  excessDue: number;
  refundDue: number;
  refundOutstanding: number;
  liquidationOverdue: boolean;
  daysToLiquidate: number | null;
  liquidation: Liquidation | null;
  liquidations: Liquidation[];
  canEdit?: boolean;
  approvalRoute?: { name: string; steps: { name: string; approvers: { id: string; name: string }[] }[] } | null;
  allocations?: {
    id: string;
    amount: number;
    payment: { id: string; number: string; kind: string; paymentDate: string; method: string; reference: string | null; clearedAt: string | null };
  }[];
}

/** When the receipts are due, and whether that has passed. */
function Deadline({ row }: { row: BudgetRequest }) {
  if (row.status !== 'RELEASED' || !row.liquidationDueDate) {
    return <span className="faint">{row.liquidationDueDate ? formatDate(row.liquidationDueDate) : '—'}</span>;
  }
  return (
    <div>
      <div>{formatDate(row.liquidationDueDate)}</div>
      {row.liquidationOverdue ? (
        <div className="faint warn">{Math.abs(row.daysToLiquidate ?? 0)} days overdue</div>
      ) : (
        <div className="faint">{row.daysToLiquidate} days left</div>
      )}
    </div>
  );
}

function StatusCell({ row }: { row: BudgetRequest }) {
  return (
    <StatusBadge
      status={row.liquidationOverdue ? 'OVERDUE' : row.status}
      extra={BUDGET_REQUEST_TONES}
      label={row.liquidationOverdue ? 'Liquidation overdue' : undefined}
    />
  );
}

/**
 * The register, in two dresses: G-OPS's (every project's requests, as the
 * project side raises them) and G-FIN's (the same rows, read as finance reads
 * them — what to release, what is out, what is overdue). One query, one
 * component, so the two can never list different sets.
 */
export function BudgetRequestsList({ finance = false }: { finance?: boolean }) {
  const navigate = useNavigate();

  const columns: Column<BudgetRequest>[] = [
    { key: 'number', label: 'Number', sortKey: 'number', render: (r) => <span className="mono">{r.number}</span> },
    {
      key: 'job',
      label: 'Project',
      render: (r) => (
        <div>
          <div>{r.job.name}</div>
          <div className="faint mono">{r.job.number}</div>
        </div>
      ),
    },
    {
      key: 'requestedBy',
      label: 'Requested by',
      render: (r) => (
        <div>
          <div>{r.requestedBy.name}</div>
          <div className="faint">{r.reason}</div>
        </div>
      ),
    },
    { key: 'category', label: 'Budget line', render: (r) => r.costCategory.name, optional: true },
    { key: 'createdAt', label: 'Raised', sortKey: 'createdAt', render: (r) => formatDate(r.createdAt), optional: true },
    { key: 'neededBy', label: 'Needed by', sortKey: 'neededBy', render: (r) => (r.neededBy ? formatDate(r.neededBy) : <span className="faint">—</span>), optional: true },
    { key: 'amount', label: 'Amount', sortKey: 'amount', align: 'right', render: (r) => <span className="mono">{formatMoney(r.amount)}</span> },
    {
      key: 'amountReleased',
      label: 'Released',
      align: 'right',
      render: (r) => (r.amountReleased > 0 ? <span className="mono">{formatMoney(r.amountReleased)}</span> : <span className="faint">—</span>),
    },
    {
      key: 'spent',
      label: 'Spent',
      align: 'right',
      optional: true,
      render: (r) => (r.liquidatedAt ? <span className="mono">{formatMoney(r.spent)}</span> : <span className="faint">—</span>),
    },
    { key: 'liquidationDueDate', label: 'Liquidate by', sortKey: 'liquidationDueDate', render: (r) => <Deadline row={r} /> },
    { key: 'status', label: 'Status', render: (r) => <StatusCell row={r} /> },
  ];

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Budget Requests</h1>
          <p>
            {finance
              ? 'Project cash. Approved requests are released here in one voucher; released ones are liquidated by the team in Expenses, with receipts, and only what was spent reaches the project. Overdue ones are past their liquidation deadline.'
              : 'Cash a project team asks for so it can buy what it needs without a purchase requisition. The project manager allows it, finance releases it, and the team accounts for it with receipts in Expenses.'}
          </p>
        </div>
      </div>

      <DataList<BudgetRequest>
        listKey={finance ? 'fin-budget-requests' : 'budget-requests'}
        endpoint="/budget-requests"
        columns={columns}
        rowKey={(r) => r.id}
        scoped={!finance}
        searchPlaceholder="Search number, purpose, project, person…"
        onRowClick={(r) => navigate(`/g-ops/budget-requests/${r.id}`)}
        emptyTitle="No budget requests"
        emptyHint="Raise one from a project's Budget Requests tab when the team needs cash in hand."
        filters={[
          { key: 'status', label: 'Status', options: STATUSES },
          { key: 'overdue', label: 'Liquidation', options: [{ value: 'true', label: 'Overdue only' }] },
        ]}
      />
    </div>
  );
}

export function BudgetRequests() {
  return <BudgetRequestsList />;
}

export function FinanceBudgetRequests() {
  return <BudgetRequestsList finance />;
}

// ── Raising one ──────────────────────────────────────────────────────────────

export interface RequestProject {
  id: string;
  number: string;
  /** The project's budget lines, when the caller already has them. */
  position?: { costCategoryId: string; name: string }[];
}

/**
 * Asking for project cash, or modifying a draft. A budget line is required:
 * the liquidation that follows charges exactly that line, and it is too late
 * to ask by then.
 */
export function BudgetRequestModal({
  job,
  existing,
  onClose,
  onSaved,
}: {
  job: RequestProject;
  existing?: BudgetRequest;
  onClose: () => void;
  onSaved: (id: string) => void;
}) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [categories, setCategories] = useState<{ id: string; name: string }[]>(
    (job.position ?? []).map((p) => ({ id: p.costCategoryId, name: p.name })),
  );
  const [form, setForm] = useState({
    costCategoryId: existing?.costCategory.id ?? '',
    amount: existing?.amount ?? 0,
    reason: existing?.reason ?? '',
    neededBy: existing?.neededBy?.slice(0, 10) ?? '',
    notes: existing?.notes ?? '',
  });

  useEffect(() => {
    if (job.position) return;
    // The project's own budget lines — the same list its Budget tab shows.
    api
      .get<{ position: { costCategoryId: string; name: string }[] }>(`/jobs/${job.id}`)
      .then((j) => setCategories(j.position.map((p) => ({ id: p.costCategoryId, name: p.name }))))
      .catch(() => {});
  }, [job.id, job.position]);

  async function save(submitNow: boolean) {
    setBusy(true);
    setError(null);
    const body = {
      jobId: job.id,
      costCategoryId: form.costCategoryId,
      amount: form.amount,
      reason: form.reason,
      neededBy: form.neededBy || null,
      notes: form.notes || null,
    };
    try {
      const saved = existing
        ? await api.put<{ id: string }>(`/budget-requests/${existing.id}`, body)
        : await api.post<{ id: string }>('/budget-requests', body);
      if (submitNow) await api.post(`/budget-requests/${saved.id}/submit`);
      toast('ok', submitNow ? 'Sent to the project manager' : existing ? 'Saved' : 'Saved as a draft');
      onSaved(saved.id);
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  }

  const valid = form.reason.trim().length >= 3 && form.amount > 0 && !!form.costCategoryId;

  return (
    <Modal
      title={existing ? `Modify ${existing.number}` : `Budget request — ${job.number}`}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button className="btn" onClick={() => save(false)} disabled={busy || !valid}>
            {existing ? 'Save' : 'Save draft'}
          </button>
          <button className="btn btn-primary" onClick={() => save(true)} disabled={busy || !valid}>
            {busy ? 'Sending…' : 'Submit for approval'}
          </button>
        </>
      }
    >
      <ErrorBox error={error} />
      <p className="muted del-lede">
        Cash for the project team to buy what it needs without a purchase requisition. It goes to
        the project manager, then finance, who releases it in one voucher. It is accounted for
        afterwards with receipts, in Expenses — and only what was spent reaches the project.
      </p>

      <Field label="What is the cash for?" required>
        <input
          value={form.reason}
          onChange={(e) => setForm({ ...form, reason: e.target.value })}
          placeholder="e.g. consumables and fittings for the Batangas tie-in"
        />
      </Field>

      <div className="grid grid-2">
        <Field label="Amount" required>
          <NumberInput
            kind="money"
            step="0.01"
            min={0}
            value={form.amount}
            onChange={(e) => setForm({ ...form, amount: Number(e.target.value) })}
          />
        </Field>
        <Field label="Needed by" hint="When the team needs the cash in hand">
          <input type="date" value={form.neededBy} onChange={(e) => setForm({ ...form, neededBy: e.target.value })} />
        </Field>
      </div>

      <Field label="Budget line" required hint="The liquidation charges exactly this line">
        <select value={form.costCategoryId} onChange={(e) => setForm({ ...form, costCategoryId: e.target.value })}>
          <option value="">— choose —</option>
          {categories.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      </Field>

      <Field label="Notes">
        <textarea rows={2} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
      </Field>
    </Modal>
  );
}

// ── The project's tab ────────────────────────────────────────────────────────

/**
 * The project's budget requests, as its tab shows them: what was asked,
 * released, spent and returned, when the receipts are due, and each one's
 * approval chain on demand — so the PM can see who is sitting on it.
 */
export function ProjectBudgetRequestsCard({
  job,
  reloadToken,
  onRaise,
}: {
  job: { id: string };
  reloadToken: number;
  onRaise?: () => void;
}) {
  const [rows, setRows] = useState<BudgetRequest[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [open, setOpen] = useState<string | null>(null);

  useEffect(() => {
    api
      .get<ListResult<BudgetRequest>>(`/budget-requests?jobId=${job.id}&pageSize=100`)
      .then((r) => setRows(r.rows))
      .catch(setError);
  }, [job.id, reloadToken]);

  const sum = (pick: (r: BudgetRequest) => number) => (rows ?? []).reduce((s, r) => s + pick(r), 0);
  const live = (rows ?? []).filter((r) => !['REJECTED', 'CANCELLED', 'DRAFT'].includes(r.status));

  return (
    <section className="card">
      <div className="del-card-head">
        <h3 className="card-title">Budget requests{rows && rows.length ? ` (${rows.length})` : ''}</h3>
        {onRaise && (
          <button className="btn btn-primary btn-sm" onClick={onRaise}>
            + Budget request
          </button>
        )}
      </div>
      <p className="muted del-lede">
        Cash for the team to buy what it needs without a purchase requisition. The project manager
        allows it, finance releases it, and it is liquidated with receipts in Expenses — only what
        was spent reaches the budget, as incurred.
      </p>
      <ErrorBox error={error} />
      {!rows && !error ? (
        <Loading />
      ) : rows && rows.length === 0 ? (
        <p className="faint del-note">No budget requests raised on this project.</p>
      ) : rows ? (
        <>
          <dl className="kv del-br-sum">
            <dt>Requested</dt>
            <dd className="mono">{formatMoney(live.reduce((s, r) => s + r.amount, 0))}</dd>
            <dt>Released</dt>
            <dd className="mono">{formatMoney(sum((r) => r.amountReleased))}</dd>
            <dt>Spent</dt>
            <dd className="mono">{formatMoney(sum((r) => r.spent))}</dd>
            <dt>Out with the team</dt>
            <dd className="mono">{formatMoney(sum((r) => (r.status === 'RELEASED' ? r.amountReleased : r.refundOutstanding)))}</dd>
          </dl>
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Number</th>
                  <th>Purpose</th>
                  <th>Budget line</th>
                  <th>Raised by</th>
                  <th className="right">Amount</th>
                  <th className="right">Released</th>
                  <th className="right">Spent</th>
                  <th>Liquidate by</th>
                  <th>Status</th>
                  <th>
                    <span className="visually-hidden">Approval</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const chained = r.status !== 'DRAFT';
                  const expanded = open === r.id;
                  return (
                    <RowGroup key={r.id}>
                      <tr>
                        <td>
                          <Link to={`/g-ops/budget-requests/${r.id}`} className="mono">
                            {r.number}
                          </Link>
                        </td>
                        <td>
                          {r.reason}
                          {r.liquidation && (
                            <div className="faint">
                              Liquidation{' '}
                              <Link to={`/g-fin/expenses/${r.liquidation.id}`} className="mono">
                                {r.liquidation.number}
                              </Link>{' '}
                              · {humanise(r.liquidation.status)}
                            </div>
                          )}
                        </td>
                        <td>{r.costCategory.name}</td>
                        <td>
                          {r.requestedBy.name}
                          <div className="faint">{formatDate(r.createdAt)}</div>
                        </td>
                        <td className="right mono">{formatMoney(r.amount)}</td>
                        <td className="right mono">{r.amountReleased > 0 ? formatMoney(r.amountReleased) : <span className="faint">—</span>}</td>
                        <td className="right mono">{r.liquidatedAt ? formatMoney(r.spent) : <span className="faint">—</span>}</td>
                        <td>
                          <Deadline row={r} />
                        </td>
                        <td>
                          <StatusCell row={r} />
                        </td>
                        <td>
                          {chained && (
                            <button
                              type="button"
                              className="btn btn-sm btn-ghost"
                              aria-expanded={expanded}
                              aria-controls={`br-approval-${r.id}`}
                              onClick={() => setOpen(expanded ? null : r.id)}
                            >
                              {expanded ? 'Hide approval' : 'Approval'}
                            </button>
                          )}
                        </td>
                      </tr>
                      {expanded && (
                        <tr className="del-expand-row">
                          <td colSpan={10} id={`br-approval-${r.id}`}>
                            <DocumentApproval documentType="budget_request" documentId={r.id} compact />
                          </td>
                        </tr>
                      )}
                    </RowGroup>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      ) : null}
    </section>
  );
}

/** A row and its expansion share one key without an extra wrapper element. */
function RowGroup({ children }: { children: ReactNode }) {
  return <>{children}</>;
}

// ── One request ──────────────────────────────────────────────────────────────

export function BudgetRequestDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const toast = useToast();
  const { me, can } = useAuth();
  const [row, setRow] = useState<BudgetRequest | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [reload, setReload] = useState(0);
  const [modal, setModal] = useState<null | 'edit' | 'release' | 'refund' | 'liquidate' | 'cancel'>(null);

  const load = useCallback(async () => {
    try {
      setRow(await api.get<BudgetRequest>(`/budget-requests/${id}`));
    } catch (err) {
      setError(err);
    }
  }, [id]);

  useEffect(() => {
    load();
  }, [load]);

  if (error && !row) return <ErrorBox error={error} />;
  if (!row) return <Loading />;

  const own = row.requestedBy.id === me?.user.id;
  const superAdmin = !!me?.user.isSuperAdmin;
  const editAll = superAdmin || can('gops.budget_requests.edit_all');
  const canModify = !!row.canEdit;
  const canSubmit = row.status === 'DRAFT' && (own || superAdmin);
  const canCancel =
    (row.status === 'DRAFT' || row.status === 'PENDING_APPROVAL' || (row.status === 'APPROVED' && row.amountReleased <= 0)) &&
    (own || editAll);
  const canLiquidate = row.status === 'RELEASED' && !row.liquidation && (own || superAdmin) && can('gfin.expenses.create');
  const seePayments = can('gfin.payments.view_all') || can('gfin.ap.view_all') || can('gfin.ar.view_all');
  const route = row.approvalRoute;

  const done = () => {
    setModal(null);
    setReload((r) => r + 1);
    load();
  };

  async function submit() {
    try {
      await api.post(`/budget-requests/${id}/submit`);
      toast('ok', 'Sent to the project manager');
      done();
    } catch (err) {
      setError(err);
    }
  }

  return (
    <div>
      <div className="breadcrumb">
        <Link to={`/g-ops/projects/${row.job.id}`}>{row.job.number}</Link>
        <span className="sep">›</span>
        <Link to={`/g-ops/projects/${row.job.id}?tab=requests`}>Budget Requests</Link>
        <span className="sep">›</span>
        <span className="mono">{row.number}</span>
      </div>

      <RecordHeader
        type="Budget Request"
        code={row.number}
        title={row.reason}
        status={row.liquidationOverdue ? 'OVERDUE' : row.status}
        statusExtra={BUDGET_REQUEST_TONES}
        amount={formatMoney(row.amount)}
        amountLabel="Requested"
        actions={
          <>
            <button className="btn" onClick={() => openPdf(`/api/budget-requests/${row.id}/pdf`, () => toast('error', 'Could not print'))}>
              Print
            </button>
            {canModify && (
              <button className="btn" onClick={() => setModal('edit')}>
                Modify
              </button>
            )}
            {canSubmit && (
              <button className="btn btn-primary" onClick={submit}>
                Submit for approval
              </button>
            )}
            {row.status === 'APPROVED' && row.toRelease > 0 && can('gfin.ap.create') && (
              <button className="btn btn-primary" onClick={() => setModal('release')}>
                Release cash
              </button>
            )}
            {canLiquidate && (
              <button className="btn btn-primary" onClick={() => setModal('liquidate')}>
                Liquidate
              </button>
            )}
            {row.status === 'REFUND_DUE' && row.refundOutstanding > 0 && can('gfin.ar.create') && (
              <button className="btn btn-primary" onClick={() => setModal('refund')}>
                Record refund
              </button>
            )}
            {canCancel && (
              <button className="btn btn-danger" onClick={() => setModal('cancel')}>
                Cancel
              </button>
            )}
          </>
        }
      />

      <p className="record-head-meta fin-gap-bottom">
        Requested by {row.requestedBy.name} on {formatDate(row.createdAt)}
        {row.neededBy && <> · needed by {formatDate(row.neededBy)}</>}
        {' · for '}
        <Link to={`/g-ops/projects/${row.job.id}`} className="mono">
          {row.job.number}
        </Link>{' '}
        {row.job.name} · {row.costCategory.name}
        {row.job.projectManager && <> · project manager {row.job.projectManager.name}</>}
      </p>

      {row.status === 'DRAFT' && route && route.steps.length > 0 && (
        <div className="qd-route">
          <span className="qd-route-label">Submit for approval sends it to</span>
          <ApprovalStepper
            steps={route.steps.map((st) => ({
              label: st.name,
              approver: st.approvers.length ? st.approvers.map((p) => p.name).join(' or ') : 'Nobody — no one else holds this role',
              status: 'WAITING',
            }))}
          />
        </div>
      )}
      {row.status !== 'DRAFT' && <DocumentApproval documentType="budget_request" documentId={row.id} reloadToken={reload} />}

      <ErrorBox error={error} />

      {row.status === 'DRAFT' && <div className="alert info">A draft. Nothing happens until it is submitted for approval.</div>}
      {row.status === 'PENDING_APPROVAL' && (
        <div className="alert info">With the project manager, then finance. Nothing is charged to the project until it is liquidated.</div>
      )}
      {row.status === 'APPROVED' && (
        <div className="alert info">
          Approved. Finance releases {formatMoney(row.toRelease)} in one voucher. Nothing is charged to the project until the receipts are in.
        </div>
      )}
      {row.status === 'RELEASED' && !row.liquidation && (
        <div className={`alert ${row.liquidationOverdue ? 'warn' : 'info'}`}>
          {formatMoney(row.amountReleased)} released
          {row.releasedAt && <> on {formatDate(row.releasedAt)}</>}.{' '}
          {row.liquidationOverdue
            ? `The receipts were due on ${formatDate(row.liquidationDueDate)} — ${Math.abs(row.daysToLiquidate ?? 0)} days ago.`
            : row.liquidationDueDate
              ? `File the receipts as a liquidation, in Expenses, by ${formatDate(row.liquidationDueDate)}.`
              : 'File the receipts as a liquidation, in Expenses.'}
        </div>
      )}
      {row.status === 'RELEASED' && row.liquidation && (
        <div className="alert info">
          Being liquidated by{' '}
          <Link to={`/g-fin/expenses/${row.liquidation.id}`} className="mono">
            {row.liquidation.number}
          </Link>{' '}
          ({humanise(row.liquidation.status)}). The figures below settle when it is approved.
        </div>
      )}
      {row.status === 'REFUND_DUE' && (
        <div className="alert warn">
          Liquidated at {formatMoney(row.spent)}. {formatMoney(row.refundOutstanding)} of unspent cash is owed back to finance.
        </div>
      )}
      {row.status === 'LIQUIDATED' && (
        <div className="alert ok">
          Liquidated. {formatMoney(row.spent)} spent and charged to {row.job.number}
          {row.excessDue > 0 && <>; the {formatMoney(row.excessDue)} over the cash released is reimbursed on the liquidation</>}
          {row.amountRefunded > 0 && <>; {formatMoney(row.amountRefunded)} of unspent cash came back</>}.
        </div>
      )}
      {row.status === 'CANCELLED' && row.cancelReason && <div className="alert warn">Cancelled — {row.cancelReason}</div>}

      <div className="grid grid-2">
        <div className="card">
          <h3 className="card-title">The money</h3>
          <dl className="kv fin-settlement">
            <dt>Requested</dt>
            <dd className="mono">{formatMoney(row.amount)}</dd>
            <dt>Released</dt>
            <dd className="mono">{row.amountReleased > 0 ? formatMoney(row.amountReleased) : <span className="faint">not yet</span>}</dd>
            <dt>Liquidate by</dt>
            <dd>
              <Deadline row={row} />
            </dd>
            <dt>Spent</dt>
            <dd className="mono">{row.liquidatedAt ? formatMoney(row.spent) : <span className="faint">not yet liquidated</span>}</dd>
            {row.liquidatedAt && row.excessDue > 0 && (
              <>
                <dt>Over the cash released — owed to {row.requestedBy.name}</dt>
                <dd className="mono fin-settlement-total">{formatMoney(row.excessDue)}</dd>
              </>
            )}
            {row.liquidatedAt && row.excessDue <= 0 && (
              <>
                <dt>Unspent — owed back</dt>
                <dd className="mono">{formatMoney(row.refundDue)}</dd>
                <dt>Returned</dt>
                <dd className="mono">{formatMoney(row.amountRefunded)}</dd>
                <dt>Still to come back</dt>
                <dd className="mono fin-settlement-total">{formatMoney(row.refundOutstanding)}</dd>
              </>
            )}
          </dl>
          {row.notes && (
            <p className="muted fin-gap-top fin-flush">
              <strong>Notes.</strong> {row.notes}
            </p>
          )}
        </div>

        <div>
          <div className="card">
            <h3 className="card-title">Liquidation</h3>
            {row.liquidations.length === 0 ? (
              <p className="muted fin-flush">
                {row.status === 'RELEASED' ? 'No receipts filed yet.' : 'Filed in Expenses once the cash has been released and spent.'}
              </p>
            ) : (
              <div className="table-wrap">
                <table className="data">
                  <tbody>
                    {row.liquidations.map((l) => (
                      <tr key={l.id}>
                        <td>
                          <Link to={`/g-fin/expenses/${l.id}`} className="mono">
                            {l.number}
                          </Link>
                          <div className="faint">{formatDate(l.claimDate)}</div>
                        </td>
                        <td>
                          <StatusBadge status={l.status} extra={CLAIM_TONES} />
                        </td>
                        <td className="right mono">{formatMoney(l.total)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          <div className="card">
            <h3 className="card-title">Payments</h3>
            {!row.allocations?.length ? (
              <p className="muted fin-flush">Nothing released yet.</p>
            ) : (
              <div className="table-wrap">
                <table className="data">
                  <tbody>
                    {row.allocations.map((a) => (
                      <tr key={a.id}>
                        <td>
                          {seePayments ? (
                            <Link to={paymentLink(a.payment.id)} className="mono">
                              {a.payment.number}
                            </Link>
                          ) : (
                            <span className="mono">{a.payment.number}</span>
                          )}
                          <div className="faint">
                            {a.payment.kind === 'RECEIPT' ? 'returned' : 'released'} · {formatDate(a.payment.paymentDate)} ·{' '}
                            {humanise(a.payment.method)}
                          </div>
                        </td>
                        <td className="right mono">{formatMoney(a.amount)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      </div>

      {modal === 'edit' && (
        <BudgetRequestModal job={{ id: row.job.id, number: row.job.number }} existing={row} onClose={() => setModal(null)} onSaved={done} />
      )}

      {modal === 'release' && (
        <RecordPaymentModal
          kind="DISBURSEMENT"
          party={{ id: row.requestedBy.id, name: row.requestedBy.name }}
          target={{ kind: 'budget_request', id: row.id, number: row.number, outstanding: row.toRelease }}
          onClose={() => setModal(null)}
          onSaved={done}
        />
      )}

      {modal === 'refund' && (
        <RecordPaymentModal
          kind="RECEIPT"
          party={{ id: row.requestedBy.id, name: row.requestedBy.name }}
          target={{ kind: 'budget_request_refund', id: row.id, number: row.number, outstanding: row.refundOutstanding }}
          onClose={() => setModal(null)}
          onSaved={done}
        />
      )}

      {modal === 'liquidate' && (
        <NewClaimModal
          budgetRequest={{
            id: row.id,
            number: row.number,
            amountReleased: row.amountReleased,
            purpose: row.reason,
            job: { id: row.job.id, number: row.job.number, name: row.job.name },
            costCategory: row.costCategory,
          }}
          onClose={() => setModal(null)}
          onCreated={(claimId) => navigate(`/g-fin/expenses/${claimId}`)}
        />
      )}

      {modal === 'cancel' && <CancelRequestModal request={row} onClose={() => setModal(null)} onDone={done} />}
    </div>
  );
}

function CancelRequestModal({ request, onClose, onDone }: { request: BudgetRequest; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  async function cancel() {
    setBusy(true);
    setError(null);
    try {
      await api.post(`/budget-requests/${request.id}/cancel`, { reason: reason || null });
      toast('ok', 'Cancelled');
      onDone();
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  }

  return (
    <Modal
      title={`Cancel ${request.number}`}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose} disabled={busy}>
            Keep it
          </button>
          <button className="btn btn-danger" onClick={cancel} disabled={busy}>
            {busy ? 'Cancelling…' : 'Cancel the request'}
          </button>
        </>
      }
    >
      <ErrorBox error={error} />
      <p className="muted">
        {request.status === 'PENDING_APPROVAL'
          ? 'The approval request is withdrawn with it, and the approvers are told.'
          : request.status === 'APPROVED'
            ? 'Nothing has been released, so nothing needs to come back.'
            : 'Nothing has been approved or released yet.'}
      </p>
      <Field label="Why?" hint="Kept on the request">
        <textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} />
      </Field>
    </Modal>
  );
}
