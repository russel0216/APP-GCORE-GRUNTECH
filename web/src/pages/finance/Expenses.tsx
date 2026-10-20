import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { DataList, type Column, type FilterDef } from '../../components/DataList';
import { Stat } from '../../components/charts';
import { usePeople } from '../../components/People';
import { RecordHeader } from '../../components/RecordHeader';
import { useConfirm } from '../../components/Confirm';
import { useBackLink } from '../../components/Navigation';
import { DocumentApproval, DecisionNote } from '../../components/ApprovalStepper';
import { Attachments } from '../../components/Attachments';
import {
  ErrorBox,
  Loading,
  StatusBadge,
  formatDate,
  formatMoney,
  humanise,
  useToast,
  type Tone,
} from '../../components/ui';
import { RecordPaymentModal, paymentLink, useTeams } from './Receivables';

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

export interface Claim {
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
  /** The claimant's team. */
  team?: { label: string; title: string } | null;
  /** Where it stands in the owner's words: TL Approval … For Release, Paid. */
  stage?: string;
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
    vendor: string | null;
    amount: number;
  }[];
  allocations?: {
    id: string;
    amount: number;
    payment: { id: string; number: string; paymentDate: string; method: string };
  }[];
}

interface ClaimsSummary {
  total: number;
  count: number;
  pending: number;
  pendingCount: number;
  forRelease: number;
  forReleaseCount: number;
  paidOut: number;
  paidCount: number;
}

/** The stage words' tones: waiting on someone, owed, done. */
const STAGE_TONES: Record<string, Tone> = {
  'TL Approval': 'warn',
  'Back Support': 'warn',
  Checking: 'warn',
  'FM Approval': 'warn',
  'CEO Approval': 'warn',
  'For Release': 'info',
  Paid: 'ok',
  Settled: 'ok',
  Rejected: 'danger',
};

/**
 * Reimbursements — the owner's module 6 (2026-10-15): Reimbursement No.,
 * Date of reimburse, Requester, Team, Project / Purpose,
 * Amount, Status in his words (TL Approval, Back Support, Checking, FM
 * Approval, CEO Approval, For Release, Paid), under the cards Sum of all
 * reimbursements, Pending process, For release and Total paid out.
 * Liquidations are the same document and stay in the list (Kind).
 */
export function Expenses() {
  const { can } = useAuth();
  const navigate = useNavigate();
  const { people } = usePeople('gfin.expenses.create');
  const teams = useTeams();

  const columns: Column<Claim>[] = [
    { key: 'number', label: 'Reimbursement No.', sortKey: 'number', width: '170px', render: (r) => <span className="mono">{r.number}</span> },
    { key: 'claimDate', label: 'Date of reimburse', sortKey: 'claimDate', render: (r) => formatDate(r.claimDate) },
    { key: 'claimedBy', label: 'Requester', render: (r) => r.claimedBy.name },
    {
      key: 'team',
      label: 'Team',
      render: (r) => (r.team ? <span title={r.team.title}>{r.team.label}</span> : <span className="faint">—</span>),
    },
    {
      key: 'purpose',
      label: 'Project / Purpose',
      render: (r) => {
        const source = liquidationSource(r);
        return (
          <div>
            <div>{r.purpose}</div>
            <div className="faint">
              {r.job ? <span className="mono">{r.job.number}</span> : 'Overheads'}
              {source && (
                <>
                  {' · liquidation of '}
                  <span className="mono">{source.number}</span>
                </>
              )}
            </div>
          </div>
        );
      },
    },
    {
      key: 'total',
      label: 'Amount',
      align: 'right',
      render: (r) => (
        <div>
          <div className="mono">{formatMoney(r.total)}</div>
          {r.status === 'APPROVED' && r.outstanding > 0 && r.outstanding < r.total && <div className="faint">{formatMoney(r.outstanding)} to pay</div>}
        </div>
      ),
    },
    {
      key: 'status',
      label: 'Status',
      render: (r) => <StatusBadge status={r.stage ?? r.status} label={r.stage} extra={{ ...CLAIM_TONES, ...STAGE_TONES }} />,
    },
    {
      key: 'kind',
      label: 'Kind',
      optional: true,
      render: (r) => (liquidationSource(r) ? 'Liquidation' : <span className="faint">Reimbursement</span>),
    },
    { key: 'lines', label: 'Lines', align: 'right', render: (r) => r.lines.length, optional: true },
  ];

  const filters: FilterDef[] = [
    { key: 'status', label: 'Status', options: STATUSES },
    { key: 'pending', label: 'Pending process', options: [{ value: 'true', label: 'In approval' }] },
    { key: 'forRelease', label: 'For release', options: [{ value: 'true', label: 'Approved, not yet paid' }] },
    { key: 'kind', label: 'Kind', options: KINDS },
    { key: 'claimedById', label: 'Requester', options: people.map((p) => ({ value: p.id, label: p.name })) },
    {
      key: 'teamId',
      label: 'Team',
      options: [...teams.map((t) => ({ value: t.id, label: `${t.code} — ${t.name}` })), { value: 'none', label: 'No team' }],
    },
    { key: 'from', toKey: 'to', label: 'Date of reimburse', type: 'dateRange' },
  ];

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Reimbursements</h1>
        </div>
      </div>

      <DataList<Claim>
        listKey="expense-claims"
        endpoint="/expense-claims"
        printPath="/api/expense-claims/pdf"
        reportPath={can('gfin.reports.view_all') ? '/g-fin/reports?kind=reimbursements' : undefined}
        columns={columns}
        rowKey={(r) => r.id}
        scoped
        selectable
        searchPlaceholder="Search number, purpose, requester, advance, budget request…"
        emptyTitle="No reimbursements yet"
        emptyHint="Every line needs a receipt number before a claim can be submitted."
        onRowClick={(r) => navigate(`/g-fin/expenses/${r.id}`)}
        filters={filters}
        summary={(raw) => {
          const sum = raw as unknown as ClaimsSummary | undefined;
          if (!sum) return null;
          return (
            <>
              <Stat label="Sum of all reimbursements" value={formatMoney(sum.total)} figure sub={`${sum.count} claim${sum.count === 1 ? '' : 's'}, rejected and cancelled left out`} />
              <Stat
                label="Pending process"
                value={formatMoney(sum.pending)}
                figure
                accent={sum.pending > 0 ? 'warn' : undefined}
                sub={`${sum.pendingCount} claim${sum.pendingCount === 1 ? '' : 's'} in approval`}
                to="/g-fin/expenses?pending=true"
              />
              <Stat label="For release" value={formatMoney(sum.forRelease)} figure sub={`${sum.forReleaseCount} approved, not yet paid`} to="/g-fin/expenses?forRelease=true" />
              <Stat label="Total paid out" value={formatMoney(sum.paidOut)} figure accent="ok" sub={`${sum.paidCount} claim${sum.paidCount === 1 ? '' : 's'}`} />
            </>
          );
        }}
        actions={
          can('gfin.expenses.create') ? (
            <button className="btn btn-primary btn-sm" onClick={() => navigate('/g-fin/expenses/new')}>
              + New reimbursement
            </button>
          ) : null
        }
      />

    </div>
  );
}

// ── One claim ────────────────────────────────────────────────────────────────

export function ExpenseClaimDetail() {
  const { id } = useParams<{ id: string }>();
  const toast = useToast();
  const navigate = useNavigate();
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
  // Modify and pull back mirror the routes: the claimant with edit_own, or edit_all.
  const editAll = !!me?.user.isSuperAdmin || can('gfin.expenses.edit_all');
  const mayEdit = (own && can('gfin.expenses.edit_own')) || editAll;
  const canModify = row.status === 'DRAFT' && mayEdit;
  const canPullBack = row.status === 'PENDING_APPROVAL' && mayEdit;

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

  // Back to a draft, its request withdrawn, then straight into Modify.
  async function pullBack() {
    await api.post(`/expense-claims/${id}/withdraw`);
    toast('ok', 'Back to a draft — the approvers were told');
    setReload((r) => r + 1);
    await load();
    navigate(`/g-fin/expenses/${id}/edit`);
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
          canPullBack && {
            label: 'Pull back and edit',
            hint: 'Back to a draft; the approvers are told',
            confirm: {
              title: `Pull ${row.number} back to draft?`,
              body: 'The approval request is withdrawn and the approvers are told. Submit it again once it is right.',
              confirmLabel: 'Pull back and edit',
              tone: 'primary',
              onConfirm: pullBack,
            },
          },
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
          row.status === 'CANCELLED' &&
            (mine || can('gfin.expenses.edit_all')) &&
            can('gfin.expenses.delete') && {
              label: 'Delete',
              danger: true,
              confirm: {
                title: `Delete ${row.number}?`,
                body: `This cancelled ${kindWord} goes for good, with its receipts. Its number is not reused.`,
                confirmLabel: 'Delete',
                onConfirm: async () => {
                  await api.del(`/expense-claims/${row.id}`);
                  toast('ok', `${row.number} deleted`);
                  navigate('/g-fin/expenses');
                },
              },
            },
        ]}
        modify={canModify ? `/g-fin/expenses/${row.id}/edit` : undefined}
        confirm={confirm}
      />

      <DecisionNote documentType="expense" documentId={row.id} reloadToken={reload} />
      <DocumentApproval documentType="expense" documentId={row.id} reloadToken={reload} />

      <ErrorBox error={error} />

      {row.status === 'PENDING_APPROVAL' && (
        <div className="alert info">
          Waiting for approval — the Approval panel says with whom. Nothing is charged to a project
          and nothing is owed until every step has approved.
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
                  <th>Company / receipt</th>
                  <th>Item / purpose</th>
                  <th className="right">Amount</th>
                </tr>
              </thead>
              <tbody>
                {row.lines.map((l) => (
                  <tr key={l.id}>
                    <td className="faint">{formatDate(l.spentOn)}</td>
                    <td>
                      <div>{l.vendor ?? '—'}</div>
                      <div className="mono faint">{l.receiptNo ?? 'No receipt no.'}</div>
                    </td>
                    <td>
                      <div>{l.description}</div>
                      {l.category && <div className="faint">{l.category}</div>}
                    </td>
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
        // Receipts change with the claim: on a draft, by whoever may modify it.
        canEdit={canModify}
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
