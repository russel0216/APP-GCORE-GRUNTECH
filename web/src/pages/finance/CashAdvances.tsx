import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { DataList, type Column } from '../../components/DataList';
import { RecordHeader } from '../../components/RecordHeader';
import { useConfirm } from '../../components/Confirm';
import { DocumentApproval } from '../../components/ApprovalStepper';
import {
  ErrorBox,
  Field,
  Loading,
  Modal,
  ModalFoot,
  StatusBadge,
  formatDate,
  formatMoney,
  humanise,
  useToast,
  type Tone,
} from '../../components/ui';
import { RecordPaymentModal, paymentLink } from './Receivables';
import { NewClaimModal, CLAIM_TONES } from './Expenses';
import { todayLocal } from '../../lib/day';
import { NumberInput } from '../../components/NumberInput';

/**
 * Cash advances — money handed to a person BEFORE it is spent.
 *
 * The life of one: a request, supervisor then finance approve it, finance
 * releases it in one voucher, and the person liquidates it with receipts (an
 * expense claim that names the advance). Nothing reaches a project's budget
 * until the liquidation is approved, and then only what was actually spent.
 * Unspent cash comes back as a receipt; overspend is reimbursed on the
 * liquidation.
 */

/**
 * An advance's own statuses. APPROVED here means finance owes a release, not
 * that the matter is closed, so it reads as information rather than success.
 */
export const ADVANCE_TONES: Record<string, Tone> = {
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

export interface Advance {
  id: string;
  number: string;
  status: string;
  requestDate: string;
  neededBy: string | null;
  purpose: string;
  notes: string | null;
  amount: number;
  amountReleased: number;
  amountSpent: number;
  amountRefunded: number;
  releasedAt: string | null;
  liquidationDueDate: string | null;
  approvedAt: string | null;
  liquidatedAt: string | null;
  requestedBy: { id: string; name: string; email: string; position: string | null };
  job: { id: string; number: string; name: string } | null;
  costCategory: { id: string; name: string } | null;
  toRelease: number;
  spent: number;
  excessDue: number;
  refundDue: number;
  refundOutstanding: number;
  liquidationOverdue: boolean;
  daysToLiquidate: number | null;
  liquidation: Liquidation | null;
  liquidations: Liquidation[];
  allocations?: {
    id: string;
    amount: number;
    payment: {
      id: string;
      number: string;
      kind: string;
      paymentDate: string;
      method: string;
      reference: string | null;
      clearedAt: string | null;
    };
  }[];
}

/** When the receipts are due, and whether that has passed. */
function Deadline({ row }: { row: Advance }) {
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

export function CashAdvances() {
  const { can } = useAuth();
  const navigate = useNavigate();
  const [filing, setFiling] = useState(false);
  const [reload, setReload] = useState(0);

  const columns: Column<Advance>[] = [
    {
      key: 'number',
      label: 'Number',
      sortKey: 'number',
      render: (r) => <span className="mono">{r.number}</span>,
    },
    {
      key: 'requestedBy',
      label: 'Requested by',
      render: (r) => (
        <div>
          <div>{r.requestedBy.name}</div>
          <div className="faint">{r.purpose}</div>
        </div>
      ),
    },
    {
      key: 'requestDate',
      label: 'Dated',
      sortKey: 'requestDate',
      render: (r) => formatDate(r.requestDate),
    },
    {
      key: 'job',
      label: 'Charged to',
      render: (r) =>
        r.job ? (
          <div>
            <div className="mono">{r.job.number}</div>
            <div className="faint">{r.costCategory?.name ?? '—'}</div>
          </div>
        ) : (
          <span className="faint">overheads</span>
        ),
    },
    {
      key: 'amount',
      label: 'Amount',
      sortKey: 'amount',
      align: 'right',
      render: (r) => <span className="mono">{formatMoney(r.amount)}</span>,
    },
    {
      key: 'amountReleased',
      label: 'Released',
      align: 'right',
      optional: true,
      render: (r) =>
        r.amountReleased > 0 ? <span className="mono">{formatMoney(r.amountReleased)}</span> : <span className="faint">—</span>,
    },
    {
      key: 'spent',
      label: 'Spent',
      align: 'right',
      optional: true,
      render: (r) =>
        r.liquidatedAt ? <span className="mono">{formatMoney(r.spent)}</span> : <span className="faint">—</span>,
    },
    {
      key: 'liquidationDueDate',
      label: 'Liquidate by',
      sortKey: 'liquidationDueDate',
      optional: true,
      render: (r) => <Deadline row={r} />,
    },
    {
      key: 'status',
      label: 'Status',
      render: (r) => (
        <StatusBadge
          status={r.liquidationOverdue ? 'OVERDUE' : r.status}
          extra={ADVANCE_TONES}
          label={r.liquidationOverdue ? 'Liquidation overdue' : undefined}
        />
      ),
    },
  ];

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Cash Advances</h1>
          <p>
            Cash handed over before it is spent — site trips, emergency purchases, anything paid in
            cash on the day. It is accounted for with receipts afterwards, and only what was
            actually spent reaches a project's budget.
          </p>
        </div>
      </div>

      <DataList<Advance>
        listKey="cash-advances"
        endpoint="/cash-advances"
        printPath="/api/cash-advances/pdf"
        columns={columns}
        rowKey={(r) => r.id}
        scoped
        reloadToken={reload}
        searchPlaceholder="Search number, purpose, person…"
        emptyTitle="No cash advances yet"
        emptyHint="Money issued before it is spent — file one with + New cash advance"
        onRowClick={(r) => navigate(`/g-fin/cash-advances/${r.id}`)}
        filters={[
          { key: 'status', label: 'Status', options: STATUSES },
          { key: 'overdue', label: 'Liquidation', options: [{ value: 'true', label: 'Overdue only' }] },
        ]}
        actions={
          can('gfin.cash_advances.create') ? (
            <button className="btn btn-primary btn-sm" onClick={() => setFiling(true)}>
              + New cash advance
            </button>
          ) : null
        }
      />

      {filing && (
        <NewCashAdvanceModal
          onClose={() => setFiling(false)}
          onSaved={(id) => {
            setFiling(false);
            setReload((r) => r + 1);
            navigate(`/g-fin/cash-advances/${id}`);
          }}
        />
      )}
    </div>
  );
}

/**
 * Asking for an advance, or modifying a draft one.
 *
 * Naming a project means naming a budget line: the liquidation that follows
 * charges exactly that line, and it is too late to ask by then.
 */
export function NewCashAdvanceModal({
  existing,
  onClose,
  onSaved,
}: {
  existing?: Advance;
  onClose: () => void;
  onSaved: (id: string) => void;
}) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [jobs, setJobs] = useState<{ id: string; number: string; name: string }[]>([]);
  const [categories, setCategories] = useState<{ id: string; name: string }[]>([]);
  const [form, setForm] = useState({
    requestDate: existing?.requestDate.slice(0, 10) ?? todayLocal(),
    neededBy: existing?.neededBy?.slice(0, 10) ?? '',
    purpose: existing?.purpose ?? '',
    amount: existing?.amount ?? 0,
    jobId: existing?.job?.id ?? '',
    costCategoryId: existing?.costCategory?.id ?? '',
    notes: existing?.notes ?? '',
  });

  useEffect(() => {
    api
      .get<{ jobs: typeof jobs; categories: typeof categories }>('/expense-claims/chargeable')
      .then((r) => {
        setJobs(r.jobs);
        setCategories(r.categories);
      })
      .catch(() => {});
  }, []);

  async function save(submitNow: boolean) {
    setBusy(true);
    setError(null);
    const body = {
      requestDate: form.requestDate,
      neededBy: form.neededBy || null,
      purpose: form.purpose,
      amount: form.amount,
      jobId: form.jobId || null,
      costCategoryId: form.jobId ? form.costCategoryId || null : null,
      notes: form.notes || null,
    };
    try {
      const saved = existing
        ? await api.put<{ id: string }>(`/cash-advances/${existing.id}`, body)
        : await api.post<{ id: string }>('/cash-advances', body);
      if (submitNow) await api.post(`/cash-advances/${saved.id}/submit`);
      toast('ok', submitNow ? 'Submitted for approval' : existing ? 'Saved' : 'Saved as a draft');
      onSaved(saved.id);
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  }

  const valid = form.purpose.trim().length >= 3 && form.amount > 0 && (!form.jobId || !!form.costCategoryId);

  return (
    <Modal
      title={existing ? `Modify cash advance ${existing.number}` : 'New cash advance'}
      onClose={onClose}
      footer={
        <ModalFoot onCancel={onClose} busy={busy}>
          <button className="btn" onClick={() => save(false)} disabled={busy || !valid}>
            {existing ? 'Save' : 'Save draft'}
          </button>
          <button className="btn btn-primary" onClick={() => save(true)} disabled={busy || !valid}>
            {busy ? 'Submitting…' : 'Submit for approval'}
          </button>
        </ModalFoot>
      }
    >
      <ErrorBox error={error} />

      <Field label="What is the cash for?" required>
        <input
          value={form.purpose}
          onChange={(e) => setForm({ ...form, purpose: e.target.value })}
          placeholder="e.g. fuel and tolls for the Batangas commissioning"
        />
      </Field>

      <div className="grid grid-2">
        <Field label="Amount" required>
          <NumberInput
            kind="money"
            step="0.01"
            min={0}
            className="fin-amount-input"
            value={form.amount}
            onChange={(e) => setForm({ ...form, amount: Number(e.target.value) })}
          />
        </Field>
        <Field label="Needed by" hint="When you need the cash in hand">
          <input
            type="date"
            value={form.neededBy}
            onChange={(e) => setForm({ ...form, neededBy: e.target.value })}
          />
        </Field>
      </div>

      <div className="grid grid-2">
        <Field label="Charge to project" hint="Leave empty if it belongs to overheads">
          <select value={form.jobId} onChange={(e) => setForm({ ...form, jobId: e.target.value })}>
            <option value="">— none —</option>
            {jobs.map((j) => (
              <option key={j.id} value={j.id}>
                {j.number} — {j.name}
              </option>
            ))}
          </select>
        </Field>
        {form.jobId && (
          <Field label="Budget line" required hint="The liquidation charges exactly this line">
            <select
              value={form.costCategoryId}
              onChange={(e) => setForm({ ...form, costCategoryId: e.target.value })}
            >
              <option value="">— choose —</option>
              {categories.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </Field>
        )}
      </div>

      <Field label="Date of request">
        <input
          type="date"
          value={form.requestDate}
          onChange={(e) => setForm({ ...form, requestDate: e.target.value })}
        />
      </Field>

      <Field label="Notes">
        <textarea rows={2} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
      </Field>

      <p className="fin-note">
        With your supervisor, then finance. Nothing is charged to a project until you liquidate it
        — and then only what you actually spent.
      </p>
    </Modal>
  );
}

// ── One advance ──────────────────────────────────────────────────────────────

export function CashAdvanceDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const toast = useToast();
  const { me, can } = useAuth();
  const [row, setRow] = useState<Advance | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [reload, setReload] = useState(0);
  const [modal, setModal] = useState<null | 'edit' | 'release' | 'refund' | 'liquidate'>(null);
  const confirm = useConfirm();

  const load = useCallback(async () => {
    try {
      setRow(await api.get<Advance>(`/cash-advances/${id}`));
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
  const editAll = superAdmin || can('gfin.cash_advances.edit_all');
  const canModify = row.status === 'DRAFT' && ((own && can('gfin.cash_advances.edit_own')) || editAll);
  const canSubmit = row.status === 'DRAFT' && (own || superAdmin);
  const canCancel =
    (row.status === 'DRAFT' || row.status === 'PENDING_APPROVAL' || (row.status === 'APPROVED' && row.amountReleased <= 0)) &&
    (own || editAll);
  const canLiquidate = row.status === 'RELEASED' && !row.liquidation && (own || superAdmin) && can('gfin.expenses.create');
  const seePayments = can('gfin.payments.view_all') || can('gfin.ap.view_all') || can('gfin.ar.view_all');

  const done = () => {
    setModal(null);
    setReload((r) => r + 1);
    load();
  };

  async function submit() {
    try {
      await api.post(`/cash-advances/${id}/submit`);
      toast('ok', 'Submitted for approval');
      done();
    } catch (err) {
      setError(err);
    }
  }

  // Thrown, not caught: the confirm bar shows the refusal and stays open.
  async function cancel(reason: string) {
    await api.post(`/cash-advances/${id}/cancel`, { reason: reason || null });
    toast('ok', 'Cancelled');
    done();
  }

  return (
    <div>
      <RecordHeader
        type="Cash Advance"
        code={row.number}
        title={row.purpose}
        status={row.status}
        statusExtra={ADVANCE_TONES}
        amount={formatMoney(row.amount)}
        amountLabel="Requested"
        meta={
          <>
            Requested by {row.requestedBy.name} on {formatDate(row.requestDate)}
            {row.neededBy && <> · needed by {formatDate(row.neededBy)}</>}
            {row.job ? (
              <>
                {' · for '}
                <Link to={`/g-ops/projects/${row.job.id}`} className="mono">
                  {row.job.number}
                </Link>{' '}
                {row.job.name}
                {row.costCategory && ` · ${row.costCategory.name}`}
              </>
            ) : (
              ' · overheads'
            )}
          </>
        }
        actions={
          <>
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
          </>
        }
        print={`/api/cash-advances/${row.id}/pdf`}
        more={[
          canCancel && {
            label: 'Cancel cash advance',
            danger: true,
            confirm: {
              title: `Cancel ${row.number}?`,
              body:
                row.status === 'PENDING_APPROVAL'
                  ? 'The approval request is withdrawn with it.'
                  : row.status === 'APPROVED'
                    ? 'Nothing has been released, so nothing needs to come back.'
                    : 'Nothing has been approved or released yet.',
              confirmLabel: 'Cancel cash advance',
              reason: 'optional',
              reasonLabel: 'Why? (kept on the advance’s notes)',
              onConfirm: cancel,
            },
          },
        ]}
        modify={canModify ? () => setModal('edit') : undefined}
        confirm={confirm}
      />

      <DocumentApproval documentType="cash_advance" documentId={row.id} reloadToken={reload} />

      <ErrorBox error={error} />

      {row.status === 'DRAFT' && (
        <div className="alert info">A draft. Nothing happens until it is sent for approval.</div>
      )}
      {row.status === 'PENDING_APPROVAL' && (
        <div className="alert info">
          With your supervisor, then finance. Nothing is charged to a project until you liquidate it.
        </div>
      )}
      {row.status === 'APPROVED' && (
        <div className="alert info">
          Approved. Finance releases {formatMoney(row.toRelease)} in one voucher. Nothing is charged
          to a project until the receipts are in.
        </div>
      )}
      {row.status === 'RELEASED' && !row.liquidation && (
        <div className={`alert ${row.liquidationOverdue ? 'warn' : 'info'}`}>
          {formatMoney(row.amountReleased)} released
          {row.releasedAt && <> on {formatDate(row.releasedAt)}</>}.{' '}
          {row.liquidationOverdue
            ? `The receipts were due on ${formatDate(row.liquidationDueDate)} — ${Math.abs(row.daysToLiquidate ?? 0)} days ago.`
            : row.liquidationDueDate
              ? `File the receipts as a liquidation by ${formatDate(row.liquidationDueDate)}.`
              : 'File the receipts as a liquidation.'}
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
          Liquidated at {formatMoney(row.spent)}. {formatMoney(row.refundOutstanding)} of unspent cash
          is owed back to finance.
        </div>
      )}
      {row.status === 'LIQUIDATED' && (
        <div className="alert ok">
          Liquidated. {formatMoney(row.spent)} spent
          {row.excessDue > 0 && <>; the {formatMoney(row.excessDue)} over the advance is reimbursed on the liquidation</>}
          {row.amountRefunded > 0 && <>; {formatMoney(row.amountRefunded)} of unspent cash came back</>}.
        </div>
      )}

      <div className="grid grid-2">
        <div className="card">
          <h3 className="card-title">The money</h3>
          <dl className="kv fin-settlement">
            <dt>Requested</dt>
            <dd className="mono">{formatMoney(row.amount)}</dd>
            <dt>Released</dt>
            <dd className="mono">
              {row.amountReleased > 0 ? formatMoney(row.amountReleased) : <span className="faint">not yet</span>}
            </dd>
            <dt>Liquidate by</dt>
            <dd>
              <Deadline row={row} />
            </dd>
            <dt>Spent</dt>
            <dd className="mono">
              {row.liquidatedAt ? formatMoney(row.spent) : <span className="faint">not yet liquidated</span>}
            </dd>
            {row.liquidatedAt && row.excessDue > 0 && (
              <>
                <dt>Over the advance — owed to {row.requestedBy.name}</dt>
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
        </div>

        <div>
          <div className="card">
            <h3 className="card-title">Liquidation</h3>
            {row.liquidations.length === 0 ? (
              <p className="muted fin-flush">
                {row.status === 'RELEASED'
                  ? 'No receipts filed yet.'
                  : 'Filed once the cash has been released and spent.'}
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
                            {a.payment.kind === 'RECEIPT' ? 'returned' : 'released'} ·{' '}
                            {formatDate(a.payment.paymentDate)} · {humanise(a.payment.method)}
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

      {modal === 'edit' && <NewCashAdvanceModal existing={row} onClose={() => setModal(null)} onSaved={done} />}

      {modal === 'release' && (
        <RecordPaymentModal
          kind="DISBURSEMENT"
          party={{ id: row.requestedBy.id, name: row.requestedBy.name }}
          target={{ kind: 'advance', id: row.id, number: row.number, outstanding: row.toRelease }}
          onClose={() => setModal(null)}
          onSaved={done}
        />
      )}

      {modal === 'refund' && (
        <RecordPaymentModal
          kind="RECEIPT"
          party={{ id: row.requestedBy.id, name: row.requestedBy.name }}
          target={{ kind: 'advance_refund', id: row.id, number: row.number, outstanding: row.refundOutstanding }}
          onClose={() => setModal(null)}
          onSaved={done}
        />
      )}

      {modal === 'liquidate' && (
        <NewClaimModal
          advance={{
            id: row.id,
            number: row.number,
            amountReleased: row.amountReleased,
            purpose: row.purpose,
            job: row.job,
            costCategory: row.costCategory,
          }}
          onClose={() => setModal(null)}
          onCreated={(claimId) => navigate(`/g-fin/expenses/${claimId}`)}
        />
      )}
    </div>
  );
}
