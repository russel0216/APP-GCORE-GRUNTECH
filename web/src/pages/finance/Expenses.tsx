import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { DataList, type Column } from '../../components/DataList';
import { RecordHeader } from '../../components/RecordHeader';
import { useConfirm } from '../../components/Confirm';
import { useBackLink } from '../../components/Navigation';
import { DocumentApproval } from '../../components/ApprovalStepper';
import { Attachments } from '../../components/Attachments';
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
import { todayLocal } from '../../lib/day';
import { NumberInput } from '../../components/NumberInput';

/**
 * Expense claims — money someone spent out of their own pocket — and
 * liquidations, which are the same document filed against a cash advance.
 *
 * The only G-FIN document that does not come from an operational one, and so
 * the only one where a person keys the amounts. That is why every line needs a
 * receipt number before it can even be submitted: finance needs an OR against
 * every peso, and finding that out at approval time wastes the approver's
 * round trip.
 *
 * A liquidation is settled against what the person is still owed — the
 * receipts less the cash they were already handed. Spent less than the
 * advance: the claim is SETTLED and the unspent cash is owed back on the
 * advance. Spent more: the claim stays APPROVED for the excess.
 */

export const STATUSES = [
  { value: 'DRAFT', label: 'Draft' },
  { value: 'PENDING_APPROVAL', label: 'Pending approval' },
  { value: 'APPROVED', label: 'Approved — awaiting reimbursement' },
  { value: 'REIMBURSED', label: 'Reimbursed' },
  { value: 'SETTLED', label: 'Settled by the advance' },
  { value: 'REJECTED', label: 'Rejected' },
  { value: 'CANCELLED', label: 'Cancelled' },
];

/** APPROVED on a claim means finance still owes somebody money. */
export const CLAIM_TONES: Record<string, Tone> = { APPROVED: 'info' };

const KINDS = [
  { value: 'reimbursement', label: 'Reimbursement' },
  { value: 'liquidation', label: 'Liquidation (advance or budget request)' },
];

/** The advance, or the budget request, a liquidation accounts for. */
interface ClaimAdvance {
  id: string;
  number: string;
  amountReleased: number;
  status: string;
  jobId: string | null;
  costCategoryId: string | null;
}

/** Where the cash a liquidation accounts for came from, and where its page is. */
function liquidationSource(row: { advance: ClaimAdvance | null; budgetRequest: ClaimAdvance | null }) {
  if (row.advance) return { ...row.advance, what: 'Advance', to: `/g-fin/cash-advances/${row.advance.id}` };
  if (row.budgetRequest) {
    return { ...row.budgetRequest, what: 'Budget request', to: `/g-ops/budget-requests/${row.budgetRequest.id}` };
  }
  return null;
}

interface Claim {
  id: string;
  number: string;
  status: string;
  kind: 'liquidation' | 'reimbursement';
  claimDate: string;
  purpose: string;
  total: number;
  amountPaid: number;
  /** What the person is still owed on this document — the excess, for a liquidation. */
  payable: number;
  outstanding: number;
  /** Unspent advance money owed back — carried on the advance, shown here. */
  refundDue: number;
  postedToJob: boolean;
  postedAt: string | null;
  notes: string | null;
  claimedBy: { id: string; name: string; email: string };
  job: { id: string; number: string; name: string } | null;
  costCategory: { id: string; name: string } | null;
  advance: ClaimAdvance | null;
  budgetRequest: ClaimAdvance | null;
  lines: {
    id: string;
    spentOn: string;
    description: string;
    category: string | null;
    receiptNo: string | null;
    amount: number;
  }[];
  allocations?: {
    id: string;
    amount: number;
    payment: { id: string; number: string; paymentDate: string; method: string };
  }[];
}

export function Expenses() {
  const { can } = useAuth();
  const navigate = useNavigate();
  const [filing, setFiling] = useState(false);
  const [reload, setReload] = useState(0);

  const columns: Column<Claim>[] = [
    {
      key: 'number',
      label: 'Number',
      sortKey: 'number',
      render: (r) => <span className="mono">{r.number}</span>,
    },
    {
      key: 'claimedBy',
      label: 'Claimed by',
      render: (r) => (
        <div>
          <div>{r.claimedBy.name}</div>
          <div className="faint">{r.purpose}</div>
        </div>
      ),
    },
    {
      key: 'kind',
      label: 'Kind',
      render: (r) => {
        const source = liquidationSource(r);
        return source ? (
          <span>
            Liquidation <span className="faint mono">{source.number}</span>
          </span>
        ) : (
          <span className="faint">Reimbursement</span>
        );
      },
    },
    {
      key: 'claimDate',
      label: 'Dated',
      sortKey: 'claimDate',
      render: (r) => formatDate(r.claimDate),
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
      key: 'lines',
      label: 'Lines',
      align: 'right',
      render: (r) => r.lines.length,
      optional: true,
    },
    {
      key: 'total',
      label: 'Spent',
      align: 'right',
      render: (r) => <span className="mono">{formatMoney(r.total)}</span>,
    },
    {
      key: 'outstanding',
      label: 'Owed back',
      align: 'right',
      render: (r) =>
        r.status === 'APPROVED' && r.outstanding > 0 ? (
          <span className="mono warn">{formatMoney(r.outstanding)}</span>
        ) : (
          <span className="faint">—</span>
        ),
    },
    {
      key: 'status',
      label: 'Status',
      render: (r) => <StatusBadge status={r.status} extra={CLAIM_TONES} />,
    },
  ];

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Expense Claims</h1>
          <p>
            What you spent on the company's behalf, and what it is owed back — including the
            receipts that liquidate a cash advance. Every line needs a receipt number: finance
            needs an OR against every peso, and a claim without one cannot be reimbursed.
          </p>
        </div>
      </div>

      <DataList<Claim>
        listKey="expense-claims"
        endpoint="/expense-claims"
        columns={columns}
        rowKey={(r) => r.id}
        scoped
        reloadToken={reload}
        searchPlaceholder="Search number, purpose, person, advance, budget request…"
        emptyTitle="No claims yet"
        onRowClick={(r) => navigate(`/g-fin/expenses/${r.id}`)}
        filters={[
          { key: 'status', label: 'Status', options: STATUSES },
          { key: 'kind', label: 'Kind', options: KINDS },
        ]}
        actions={
          can('gfin.expenses.create') ? (
            <button className="btn btn-primary btn-sm" onClick={() => setFiling(true)}>
              + New expense claim
            </button>
          ) : null
        }
      />

      {filing && (
        <NewClaimModal
          onClose={() => setFiling(false)}
          onCreated={(id) => {
            setFiling(false);
            setReload((r) => r + 1);
            navigate(`/g-fin/expenses/${id}`);
          }}
        />
      )}
    </div>
  );
}

/** The advance a liquidation is filed against — what the modal needs to know. */
export interface LiquidatingAdvance {
  id: string;
  number: string;
  amountReleased: number;
  purpose: string;
  job: { id: string; number: string; name: string } | null;
  costCategory: { id: string; name: string } | null;
}

/**
 * Filing a claim, or — with `advance` or `budgetRequest` — liquidating a cash
 * advance or a budget request (project cash).
 *
 * A liquidation takes its project and budget line from what it accounts for
 * and cannot change them: the cost lands where it was approved to land.
 */
export function NewClaimModal({
  advance: advanceProp,
  budgetRequest,
  onClose,
  onCreated,
}: {
  advance?: LiquidatingAdvance;
  budgetRequest?: LiquidatingAdvance;
  onClose: () => void;
  onCreated: (id: string) => void;
}) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [jobs, setJobs] = useState<{ id: string; number: string; name: string }[]>([]);
  const [categories, setCategories] = useState<{ id: string; name: string }[]>([]);
  // What the receipts account for, whichever it is; the form reads one thing.
  const advance = advanceProp ?? budgetRequest;
  const cashWord = advanceProp ? 'advance' : 'budget request';

  const today = todayLocal();
  const [form, setForm] = useState({
    claimDate: today,
    purpose: advance ? `Liquidation of ${advance.number} — ${advance.purpose}` : '',
    jobId: '',
    costCategoryId: '',
  });
  const [lines, setLines] = useState([
    { spentOn: today, description: '', category: '', receiptNo: '', amount: 0 },
  ]);

  useEffect(() => {
    if (advance) return;
    // Not /jobs/lookup: naming the project you spent money on is not the same
    // right as project-management access, and the filing roles hold none.
    api
      .get<{ jobs: typeof jobs; categories: typeof categories }>('/expense-claims/chargeable')
      .then((r) => {
        setJobs(r.jobs);
        setCategories(r.categories);
      })
      .catch(() => {});
  }, [advance]);

  const total = lines.reduce((s, l) => s + (l.amount || 0), 0);
  const missingReceipts = lines.filter((l) => l.description.trim() && !l.receiptNo.trim()).length;
  const difference = advance ? Math.round((total - advance.amountReleased) * 100) / 100 : 0;

  async function create(submitNow: boolean) {
    setBusy(true);
    setError(null);
    try {
      const created = await api.post<{ id: string }>('/expense-claims', {
        claimDate: form.claimDate,
        purpose: form.purpose,
        advanceId: advanceProp?.id ?? null,
        budgetRequestId: budgetRequest?.id ?? null,
        jobId: advance ? advance.job?.id ?? null : form.jobId || null,
        costCategoryId: advance ? advance.costCategory?.id ?? null : form.jobId ? form.costCategoryId || null : null,
        lines: lines
          .filter((l) => l.description.trim() && l.amount > 0)
          .map((l) => ({
            spentOn: l.spentOn,
            description: l.description,
            category: l.category || null,
            receiptNo: l.receiptNo || null,
            amount: l.amount,
          })),
      });
      if (submitNow) await api.post(`/expense-claims/${created.id}/submit`);
      toast('ok', submitNow ? 'Submitted for approval' : 'Saved as a draft');
      onCreated(created.id);
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  }

  const valid = form.purpose.trim().length >= 3 && total > 0 && (advance || !form.jobId || !!form.costCategoryId);

  return (
    <Modal
      title={advance ? `Liquidate ${advance.number}` : 'New expense claim'}
      onClose={onClose}
      wide
      footer={
        <ModalFoot onCancel={onClose} busy={busy}>
          <button className="btn" onClick={() => create(false)} disabled={busy || !valid}>
            Save draft
          </button>
          <button
            className="btn btn-primary"
            onClick={() => create(true)}
            disabled={busy || !valid || missingReceipts > 0}
          >
            {busy ? 'Submitting…' : 'Submit for approval'}
          </button>
        </ModalFoot>
      }
    >
      <ErrorBox error={error} />

      {advance && (
        <div className="alert info">
          {formatMoney(advance.amountReleased)} was released to you. List every receipt against it.
          It is charged to{' '}
          {advance.job ? (
            <>
              <span className="mono">{advance.job.number}</span> ·{' '}
              {advance.costCategory?.name ?? 'no budget line'}
            </>
          ) : (
            'overheads'
          )}{' '}
          — the project the {cashWord} was approved for.
        </div>
      )}

      <div className="grid grid-2">
        <Field label={advance ? 'Date of liquidation' : 'Date of claim'}>
          <input
            type="date"
            value={form.claimDate}
            onChange={(e) => setForm({ ...form, claimDate: e.target.value })}
          />
        </Field>
        <Field label="What was it for?">
          <input
            value={form.purpose}
            onChange={(e) => setForm({ ...form, purpose: e.target.value })}
            placeholder="e.g. site visit to the Cebu plant"
          />
        </Field>
      </div>

      {!advance && (
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
            <Field label="Budget line" hint="Which part of the project's budget this spends">
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
      )}

      <h4 className="fin-section-title">What you spent</h4>
      <div className="table-wrap">
        <table className="data">
          <thead>
            <tr>
              <th>Date</th>
              <th>Description</th>
              <th>Kind</th>
              <th>Receipt no.</th>
              <th className="right">Amount</th>
              <th className="fin-col-tight" />
            </tr>
          </thead>
          <tbody>
            {lines.map((l, i) => {
              const update = (patch: Partial<typeof l>) => {
                const next = [...lines];
                next[i] = { ...l, ...patch };
                setLines(next);
              };
              return (
                <tr key={i}>
                  <td>
                    <input
                      type="date"
                      aria-label={`Line ${i + 1} date`}
                      value={l.spentOn}
                      onChange={(e) => update({ spentOn: e.target.value })}
                    />
                  </td>
                  <td>
                    <input
                      aria-label={`Line ${i + 1} description`}
                      value={l.description}
                      onChange={(e) => update({ description: e.target.value })}
                      placeholder="Fare, meals, accommodation…"
                    />
                  </td>
                  <td>
                    <input
                      aria-label={`Line ${i + 1} kind`}
                      value={l.category}
                      onChange={(e) => update({ category: e.target.value })}
                    />
                  </td>
                  <td>
                    <input
                      aria-label={`Line ${i + 1} receipt number`}
                      value={l.receiptNo}
                      onChange={(e) => update({ receiptNo: e.target.value })}
                      placeholder="OR / SI no."
                    />
                  </td>
                  <td>
                    <NumberInput
                      kind="money"
                      step="0.01"
                      min={0}
                      aria-label={`Line ${i + 1} amount`}
                      className="fin-amount-input"
                      value={l.amount}
                      onChange={(e) => update({ amount: Number(e.target.value) })}
                    />
                  </td>
                  <td className="right">
                    {lines.length > 1 && (
                      <button
                        className="btn btn-ghost btn-sm"
                        aria-label={`Remove line ${i + 1}`}
                        onClick={() => setLines(lines.filter((_, j) => j !== i))}
                      >
                        Remove
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
          <tfoot>
            <tr>
              <th colSpan={4} className="right">
                Total
              </th>
              <th className="right mono">{formatMoney(total)}</th>
              <th />
            </tr>
          </tfoot>
        </table>
      </div>
      <button
        className="btn btn-sm fin-gap-top-sm"
        onClick={() =>
          setLines([...lines, { spentOn: today, description: '', category: '', receiptNo: '', amount: 0 }])
        }
      >
        + Add line
      </button>

      {advance && total > 0 && (
        <p className="fin-note">
          {difference > 0.005
            ? `You spent ${formatMoney(difference)} more than the ${cashWord} — once approved, finance reimburses the excess.`
            : difference < -0.005
              ? `${formatMoney(-difference)} of the ${cashWord} was not spent — once approved, return it to finance.`
              : `The receipts match the ${cashWord} exactly — nothing will be owed either way.`}
        </p>
      )}

      {missingReceipts > 0 && (
        <div className="alert warn fin-gap-top fin-flush">
          {missingReceipts} line{missingReceipts === 1 ? ' has' : 's have'} no receipt number. You
          can save this as a draft, but it cannot be submitted until every peso has an OR against
          it.
        </div>
      )}
    </Modal>
  );
}

// ── One claim ────────────────────────────────────────────────────────────────

export function ExpenseClaimDetail() {
  const { id } = useParams<{ id: string }>();
  const toast = useToast();
  const { me, can } = useAuth();
  const [row, setRow] = useState<Claim | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [paying, setPaying] = useState(false);
  const [reload, setReload] = useState(0);
  const confirm = useConfirm();

  const load = useCallback(async () => {
    try {
      setRow(await api.get<Claim>(`/expense-claims/${id}`));
    } catch (err) {
      setError(err);
    }
  }, [id]);

  useEffect(() => {
    load();
  }, [load]);

  // A liquidation goes back to the advance or budget request it accounts for.
  const source = row ? liquidationSource(row) : null;
  const liquidation = !!row && row.kind === 'liquidation' && !!source;
  useBackLink(liquidation ? source?.to : null, liquidation ? source?.number : null);

  if (error && !row) return <ErrorBox error={error} />;
  if (!row) return <Loading />;

  const own = row.claimedBy.id === me?.user.id;
  // The server lets a super admin act on anybody's draft; the buttons agree.
  const mine = own || !!me?.user.isSuperAdmin;

  async function submit() {
    try {
      await api.post(`/expense-claims/${id}/submit`);
      toast('ok', 'Submitted for approval');
      setReload((r) => r + 1);
      load();
    } catch (err) {
      setError(err);
    }
  }

  // Thrown, not caught: the confirm bar shows the refusal and stays open.
  async function cancel() {
    await api.post(`/expense-claims/${id}/cancel`);
    toast('ok', 'Cancelled');
    setReload((r) => r + 1);
    await load();
  }

  const open = row.status === 'DRAFT' || row.status === 'PENDING_APPROVAL';
  const kindWord = liquidation ? 'liquidation' : 'claim';

  return (
    <div>
      <RecordHeader
        type={liquidation ? 'Liquidation' : 'Expense Claim'}
        code={row.number}
        title={row.purpose}
        status={row.status}
        statusExtra={CLAIM_TONES}
        amount={formatMoney(row.total)}
        amountLabel={liquidation ? 'Receipts total' : 'Claimed'}
        meta={
          <>
            {row.claimedBy.name} · {formatDate(row.claimDate)}
            {liquidation && source && (
              <>
                {` · liquidates ${source.what.toLowerCase()} `}
                <Link to={source.to} className="mono">
                  {source.number}
                </Link>
              </>
            )}
            {row.job ? (
              <>
                {' · charged to '}
                <Link to={`/g-ops/projects/${row.job.id}`} className="mono">
                  {row.job.number}
                </Link>{' '}
                {row.costCategory ? `· ${row.costCategory.name}` : ''}
              </>
            ) : (
              ' · overheads'
            )}
          </>
        }
        actions={
          <>
            {row.status === 'DRAFT' && mine && (
              <button className="btn btn-primary" onClick={submit}>
                Submit for approval
              </button>
            )}
            {row.status === 'APPROVED' && row.outstanding > 0 && can('gfin.ap.create') && (
              <button className="btn btn-primary" onClick={() => setPaying(true)}>
                {liquidation ? 'Reimburse the excess' : 'Reimburse'}
              </button>
            )}
          </>
        }
        print={`/api/expense-claims/${row.id}/pdf`}
        more={[
          open &&
            (mine || can('gfin.expenses.edit_all')) && {
              label: `Cancel ${kindWord}`,
              danger: true,
              confirm: {
                title: `Cancel ${row.number}?`,
                body:
                  row.status === 'PENDING_APPROVAL'
                    ? 'The approval request is withdrawn with it, and the approvers are told.'
                    : 'Nothing has been approved or paid on it.',
                confirmLabel: `Cancel ${kindWord}`,
                onConfirm: cancel,
              },
            },
        ]}
        confirm={confirm}
      />

      <DocumentApproval documentType="expense" documentId={row.id} reloadToken={reload} />

      <ErrorBox error={error} />

      {row.status === 'PENDING_APPROVAL' && (
        <div className="alert info">
          With your supervisor, then finance. Nothing is charged to a project and nothing is owed
          until both have approved.
        </div>
      )}
      {row.status === 'APPROVED' && (
        <div className="alert ok">
          Approved. {formatMoney(row.outstanding)} is owed back to {row.claimedBy.name}
          {liquidation && <> — the receipts came to more than the cash released</>}
          {row.postedToJob && row.job && <>, and {formatMoney(row.total)} was charged to {row.job.number}</>}.
        </div>
      )}
      {row.status === 'SETTLED' && (
        <div className="alert ok">
          Settled by the cash released — nobody is owed anything on this liquidation
          {row.refundDue > 0 && source && (
            <>
              . {formatMoney(row.refundDue)} of unspent cash is owed back on{' '}
              <Link to={source.to} className="mono">
                {source.number}
              </Link>
            </>
          )}
          {row.postedToJob && row.job && <>. {formatMoney(row.total)} was charged to {row.job.number}</>}.
        </div>
      )}

      <div className="grid grid-2">
        <div className="card">
          <h3 className="card-title">What was spent</h3>
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Description</th>
                  <th>Receipt</th>
                  <th className="right">Amount</th>
                </tr>
              </thead>
              <tbody>
                {row.lines.map((l) => (
                  <tr key={l.id}>
                    <td className="faint">{formatDate(l.spentOn)}</td>
                    <td>
                      <div>{l.description}</div>
                      {l.category && <div className="faint">{l.category}</div>}
                    </td>
                    <td className="mono faint">{l.receiptNo ?? '—'}</td>
                    <td className="right mono">{formatMoney(l.amount)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <th colSpan={3} className="right">
                    Total
                  </th>
                  <th className="right mono">{formatMoney(row.total)}</th>
                </tr>
              </tfoot>
            </table>
          </div>
        </div>

        <div className="card">
          <h3 className="card-title">Settlement</h3>
          <dl className="kv fin-settlement">
            {liquidation && source ? (
              <>
                <dt>{source.what}</dt>
                <dd>
                  <Link to={source.to} className="mono">
                    {source.number}
                  </Link>
                </dd>
                <dt>Released to {row.claimedBy.name}</dt>
                <dd className="mono">{formatMoney(source.amountReleased)}</dd>
                <dt>Receipts</dt>
                <dd className="mono">{formatMoney(row.total)}</dd>
                {row.payable > 0 ? (
                  <>
                    <dt>Excess owed to {row.claimedBy.name}</dt>
                    <dd className="mono">{formatMoney(row.payable)}</dd>
                    <dt>Paid back</dt>
                    <dd className="mono">{formatMoney(row.amountPaid)}</dd>
                    <dt>Still owed</dt>
                    <dd className="mono fin-settlement-total">{formatMoney(row.outstanding)}</dd>
                  </>
                ) : (
                  <>
                    <dt>Unspent — owed back to finance</dt>
                    <dd className="mono fin-settlement-total">{formatMoney(row.refundDue)}</dd>
                  </>
                )}
              </>
            ) : (
              <>
                <dt>Claimed</dt>
                <dd className="mono">{formatMoney(row.total)}</dd>
                <dt>Paid back</dt>
                <dd className="mono">{formatMoney(row.amountPaid)}</dd>
                <dt>Still owed</dt>
                <dd className="mono fin-settlement-total">{formatMoney(row.outstanding)}</dd>
              </>
            )}
            <dt>Charged to</dt>
            <dd>
              {row.job ? (
                <>
                  <span className="mono">{row.job.number}</span>
                  <span className="faint"> · {row.costCategory?.name ?? 'no budget line'}</span>
                </>
              ) : (
                <span className="faint">overheads — no project charged</span>
              )}
            </dd>
          </dl>

          {row.allocations && row.allocations.length > 0 && (
            <div className="table-wrap fin-gap-top">
              <table className="data">
                <tbody>
                  {row.allocations.map((a) => (
                    <tr key={a.id}>
                      <td>
                        {can('gfin.payments.view_all') || can('gfin.ap.view_all') || can('gfin.ar.view_all') ? (
                          <Link to={paymentLink(a.payment.id)} className="mono">
                            {a.payment.number}
                          </Link>
                        ) : (
                          <span className="mono">{a.payment.number}</span>
                        )}
                        <div className="faint">
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

      <Attachments
        entityType="expense_claim"
        entityId={row.id}
        title="Receipts"
        hint="Scans or photos of the ORs listed above."
        canEdit={own && open}
      />

      {paying && (
        <RecordPaymentModal
          kind="DISBURSEMENT"
          party={{ id: row.claimedBy.id, name: row.claimedBy.name }}
          target={{ kind: 'claim', id: row.id, number: row.number, outstanding: row.outstanding }}
          onClose={() => setPaying(false)}
          onSaved={() => {
            setPaying(false);
            load();
          }}
        />
      )}
    </div>
  );
}
