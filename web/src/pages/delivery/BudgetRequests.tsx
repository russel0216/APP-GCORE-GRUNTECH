import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api, type ListResult } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { DataList, type Column, type FilterDef } from '../../components/DataList';
import { Stat } from '../../components/charts';
import { usePeople } from '../../components/People';
import { useTeams } from '../finance/Receivables';
import { RecordHeader } from '../../components/RecordHeader';
import { useConfirm } from '../../components/Confirm';
import { useBackLink } from '../../components/Navigation';
import { ApprovalStepper, DocumentApproval, DecisionNote } from '../../components/ApprovalStepper';
import { ErrorBox, Loading, StatusBadge, formatDate, formatMoney, humanise, useToast, type Tone } from '../../components/ui';
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
  /** The requester's team, else their department. */
  team: { label: string; title: string; teamId: string | null } | null;
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
  /** The breakdown of what the cash buys; the amount is their sum. */
  items?: { id: string; name: string; description: string | null; quantity: number; unit: string; unitCost: number; amount: number }[];
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

interface RequestsSummary {
  total: number;
  count: number;
  approved: number;
  approvedCount: number;
  pending: number;
  pendingCount: number;
  toRelease: number;
  toReleaseCount: number;
  released: number;
  releasedCount: number;
  spent: number;
  returned: number;
  owedBack: number;
  refundDueCount: number;
}

/**
 * The register, in two dresses: G-OPS's (every project's requests, as the
 * project side raises them) and G-FIN's — the owner's module 4: BR No.,
 * Requester, Team (else department), Project / Purpose, Amount, Date needed,
 * Status, under the cards Sum of all budget requests, Approved funds, Pending
 * approval and To release. One query, one component, so the two can never
 * list different sets.
 */
export function BudgetRequestsList({ finance = false }: { finance?: boolean }) {
  const navigate = useNavigate();
  const { can } = useAuth();
  const { people } = usePeople('gops.budget_requests.create');
  const teams = useTeams();

  const columns: Column<BudgetRequest>[] = [
    { key: 'number', label: 'BR No.', sortKey: 'number', width: '150px', render: (r) => <span className="mono">{r.number}</span> },
    { key: 'requestedBy', label: 'Requester', render: (r) => r.requestedBy.name },
    {
      key: 'team',
      label: 'Team',
      render: (r) => (r.team ? <span title={r.team.title}>{r.team.label}</span> : <span className="faint">—</span>),
    },
    {
      key: 'job',
      label: 'Project / Purpose',
      render: (r) => (
        <div>
          <div>{r.reason}</div>
          <div className="faint">
            <span className="mono">{r.job.number}</span> {r.job.name}
          </div>
        </div>
      ),
    },
    { key: 'amount', label: 'Amount', sortKey: 'amount', align: 'right', render: (r) => <span className="mono">{formatMoney(r.amount)}</span> },
    {
      key: 'neededBy',
      label: 'Date needed',
      sortKey: 'neededBy',
      render: (r) => (r.neededBy ? formatDate(r.neededBy) : <span className="faint">—</span>),
    },
    { key: 'status', label: 'Status', render: (r) => <StatusCell row={r} /> },
    { key: 'category', label: 'Budget line', render: (r) => r.costCategory.name, optional: true },
    { key: 'createdAt', label: 'Raised', sortKey: 'createdAt', render: (r) => formatDate(r.createdAt), optional: true },
    {
      key: 'amountReleased',
      label: 'Released',
      align: 'right',
      optional: true,
      render: (r) => (r.amountReleased > 0 ? <span className="mono">{formatMoney(r.amountReleased)}</span> : <span className="faint">—</span>),
    },
    { key: 'liquidationDueDate', label: 'Liquidate by', sortKey: 'liquidationDueDate', optional: true, render: (r) => <Deadline row={r} /> },
  ];

  const filters: FilterDef[] = [
    { key: 'status', label: 'Status', options: STATUSES },
    { key: 'pending', label: 'Pending', options: [{ value: 'true', label: 'Pending approval' }] },
    { key: 'approved', label: 'Approved funds', options: [{ value: 'true', label: 'Approved and after' }] },
    { key: 'overdue', label: 'Liquidation', options: [{ value: 'true', label: 'Overdue only' }] },
    { key: 'requestedById', label: 'Requester', options: people.map((p) => ({ value: p.id, label: p.name })) },
    {
      key: 'teamId',
      label: 'Team',
      options: [...teams.map((t) => ({ value: t.id, label: `${t.code} — ${t.name}` })), { value: 'none', label: 'No team' }],
    },
    { key: 'neededFrom', toKey: 'neededTo', label: 'Date needed', type: 'dateRange' },
  ];

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Budget Requests</h1>
        </div>
      </div>

      <DataList<BudgetRequest>
        listKey={finance ? 'fin-budget-requests' : 'budget-requests'}
        endpoint="/budget-requests"
        printPath="/api/budget-requests/pdf"
        reportPath={finance ? '/g-fin/reports?kind=budget-requests' : undefined}
        columns={columns}
        rowKey={(r) => r.id}
        scoped={!finance}
        selectable
        searchPlaceholder="Search BR no., purpose, project, requester…"
        onRowClick={(r) => navigate(`/g-ops/budget-requests/${r.id}`)}
        emptyTitle="No budget requests"
        emptyHint="Every request names a project — for office or operations cash, raise it against the operations budget's project."
        filters={filters}
        summary={(raw) => {
          const sum = raw as unknown as RequestsSummary | undefined;
          if (!sum) return null;
          return (
            <>
              <Stat label="Sum of all budget requests" value={formatMoney(sum.total)} figure sub={`${sum.count} request${sum.count === 1 ? '' : 's'}, rejected and cancelled left out`} />
              <Stat label="Approved funds" value={formatMoney(sum.approved)} figure accent="ok" sub={`${sum.approvedCount} approved`} to={`${finance ? '/g-fin' : '/g-ops'}/budget-requests?approved=true`} />
              <Stat
                label="Pending approval"
                value={formatMoney(sum.pending)}
                figure
                accent={sum.pending > 0 ? 'warn' : undefined}
                sub={`${sum.pendingCount} waiting`}
                to={`${finance ? '/g-fin' : '/g-ops'}/budget-requests?pending=true`}
              />
              <Stat
                label="To release"
                value={formatMoney(sum.toRelease)}
                figure
                sub={`${sum.toReleaseCount} approved, not yet released`}
                to={`${finance ? '/g-fin' : '/g-ops'}/budget-requests?status=APPROVED`}
              />
            </>
          );
        }}
        actions={
          can('gops.budget_requests.create') ? (
            <button className="btn btn-primary btn-sm" onClick={() => navigate('/g-ops/budget-requests/new')}>
              + Add budget request
            </button>
          ) : null
        }
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

/**
 * Budget Liquidations — the owner's module 5 (2026-10-15): the requests
 * whose cash went out, as the liquidation account reads them — released,
 * spent, the return — with the next step on each row: the requester's
 * "Actual entry" (the itemised liquidation, its receipts attached) while it
 * is out, finance's "Process" (the refund) while unspent cash is owed back.
 * The same rows as the register, narrowed to `released=true`.
 */
export function FinanceLiquidations() {
  const navigate = useNavigate();
  const { me } = useAuth();
  const teams = useTeams();
  const { people } = usePeople('gops.budget_requests.create');
  const ret = (r: BudgetRequest) => (r.liquidatedAt ? Math.max(0, Math.round((r.amountReleased - r.spent) * 100) / 100) : null);

  const columns: Column<BudgetRequest>[] = [
    { key: 'number', label: 'BR No.', sortKey: 'number', width: '150px', render: (r) => <span className="mono">{r.number}</span> },
    {
      key: 'requestedBy',
      label: 'Requester / Team',
      render: (r) => (
        <div>
          <div>{r.requestedBy.name}</div>
          <div className="faint">{r.team?.label ?? '—'}</div>
        </div>
      ),
    },
    {
      key: 'job',
      label: 'Project / Purpose',
      render: (r) => (
        <div>
          <div>{r.reason}</div>
          <div className="faint mono">{r.job.number}</div>
        </div>
      ),
    },
    { key: 'amountReleased', label: 'Released', align: 'right', render: (r) => <span className="mono">{formatMoney(r.amountReleased)}</span> },
    {
      key: 'spent',
      label: 'Spent',
      align: 'right',
      render: (r) =>
        r.liquidatedAt ? (
          <span className="mono">{formatMoney(r.spent)}</span>
        ) : r.liquidation ? (
          <span className="faint">{formatMoney(r.liquidation.total)} filed</span>
        ) : (
          <span className="faint">—</span>
        ),
    },
    {
      key: 'return',
      label: 'Return',
      align: 'right',
      render: (r) => {
        const back = ret(r);
        return back === null ? <span className="faint">—</span> : <span className="mono">{formatMoney(back)}</span>;
      },
    },
    { key: 'status', label: 'Status', render: (r) => <StatusCell row={r} /> },
    {
      key: 'actions',
      label: 'Actions',
      render: (r) => {
        const go = (act: string) => (e: React.MouseEvent) => {
          e.stopPropagation();
          navigate(`/g-ops/budget-requests/${r.id}?act=${act}`);
        };
        if (r.status === 'RELEASED' && !r.liquidation && r.requestedBy.id === me?.user.id) {
          return (
            <button type="button" className="btn btn-sm" onClick={go('liquidate')}>
              Actual entry
            </button>
          );
        }
        if (r.status === 'REFUND_DUE' && r.refundOutstanding > 0) {
          return (
            <button type="button" className="btn btn-sm" onClick={go('refund')}>
              Process
            </button>
          );
        }
        if (r.status === 'RELEASED' && r.liquidation) return <span className="faint">Liquidation {humanise(r.liquidation.status).toLowerCase()}</span>;
        if (r.status === 'RELEASED') return <Deadline row={r} />;
        return <span className="faint">—</span>;
      },
    },
  ];

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Budget Liquidations</h1>
        </div>
      </div>
      <DataList<BudgetRequest>
        listKey="fin-budget-liquidations"
        endpoint="/budget-requests"
        printPath="/api/budget-requests/pdf"
        reportPath="/g-fin/reports?kind=liquidations"
        initialFilters={{ released: 'true' }}
        columns={columns}
        rowKey={(r) => r.id}
        scoped={false}
        selectable
        searchPlaceholder="Search BR no., purpose, project, requester…"
        onRowClick={(r) => navigate(`/g-ops/budget-requests/${r.id}`)}
        emptyTitle="No cash out yet"
        emptyHint="A budget request appears here once finance releases its cash."
        filters={[
          {
            key: 'status',
            label: 'Status',
            options: STATUSES.filter((st) => ['RELEASED', 'REFUND_DUE', 'LIQUIDATED'].includes(st.value)),
          },
          { key: 'overdue', label: 'Liquidation', options: [{ value: 'true', label: 'Overdue only' }] },
          { key: 'requestedById', label: 'Requester', options: people.map((p) => ({ value: p.id, label: p.name })) },
          {
            key: 'teamId',
            label: 'Team',
            options: [...teams.map((t) => ({ value: t.id, label: `${t.code} — ${t.name}` })), { value: 'none', label: 'No team' }],
          },
        ]}
        summary={(raw) => {
          const sum = raw as unknown as RequestsSummary | undefined;
          if (!sum) return null;
          return (
            <>
              <Stat
                label="Sum of all liquidation accounts"
                value={formatMoney(sum.released)}
                figure
                sub={`Released · ${formatMoney(sum.spent)} spent on the liquidated`}
              />
              <Stat label="Total excess returned" value={formatMoney(sum.returned)} figure accent="ok" sub="unspent cash handed back" />
              <Stat
                label="Still owed back"
                value={formatMoney(sum.owedBack)}
                figure
                accent={sum.owedBack > 0 ? 'warn' : undefined}
                sub={`${sum.refundDueCount} to process`}
                to="/g-fin/budget-liquidations?status=REFUND_DUE"
              />
            </>
          );
        }}
      />
    </div>
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
      <div className="card-head">
        <h3 className="card-title">Budget requests{rows && rows.length ? ` (${rows.length})` : ''}</h3>
        {onRaise && (
          <button className="btn btn-primary btn-sm" onClick={onRaise}>
            + New budget request
          </button>
        )}
      </div>
      <p className="muted del-lede">
        Cash for the team to buy what it needs without a purchase requisition. The team leader, back
        support and the finance manager allow it, finance releases it, and it is liquidated with receipts in Expenses — only what
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
  const confirm = useConfirm();
  const [row, setRow] = useState<BudgetRequest | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [reload, setReload] = useState(0);
  const [modal, setModal] = useState<null | 'release' | 'refund' | 'liquidate'>(null);
  // `?act=liquidate|refund` — Budget Liquidations' "Actual entry" and
  // "Process" land here with the form open, read once and dropped.
  const [params, setParams] = useSearchParams();
  const act = params.get('act');

  /*
    Back goes to the project's Budget Requests tab for the project side, and
    to G-FIN's register for finance, who may not open projects at all.
  */
  const projectSide =
    (can('gops.budget_requests.view_all') || can('gops.budget_requests.view_own')) &&
    (can('gops.projects.view_all') || can('gops.projects.view_own'));
  const financeSide = can('gfin.budget_requests.view_all');
  useBackLink(
    row && projectSide ? `/g-ops/projects/${row.job.id}?tab=requests` : row && financeSide ? '/g-fin/budget-requests' : null,
    row && projectSide ? `${row.job.number} Budget Requests` : row && financeSide ? 'Budget Requests' : null,
  );

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

  useEffect(() => {
    if (!row || !act) return;
    if (act === 'liquidate' || act === 'refund') setModal(act);
    const next = new URLSearchParams(params);
    next.delete('act');
    setParams(next, { replace: true });
  }, [row, act, params, setParams]);

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
      toast('ok', 'Sent for approval');
      done();
    } catch (err) {
      setError(err);
    }
  }

  /** Asked in the confirm bar first; a refusal is shown there. */
  async function cancel(reason: string) {
    await api.post(`/budget-requests/${id}/cancel`, { reason: reason || null });
    toast('ok', 'Cancelled');
    done();
  }

  async function remove() {
    await api.del(`/budget-requests/${id}`);
    toast('ok', `${row!.number} deleted`);
    navigate(-1);
  }

  return (
    <div>
      <RecordHeader
        type="Budget Request"
        code={row.number}
        title={row.reason}
        status={row.liquidationOverdue ? 'OVERDUE' : row.status}
        statusExtra={BUDGET_REQUEST_TONES}
        amount={formatMoney(row.amount)}
        amountLabel="Requested"
        meta={
          <>
            Requested by {row.requestedBy.name} on {formatDate(row.createdAt)}
            {row.neededBy && <> · needed by {formatDate(row.neededBy)}</>}
            {' · for '}
            <Link to={`/g-ops/projects/${row.job.id}`} className="mono">
              {row.job.number}
            </Link>{' '}
            {row.job.name} · {row.costCategory.name}
            {row.job.projectManager && <> · Technical Manager {row.job.projectManager.name}</>}
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
        print={`/api/budget-requests/${row.id}/pdf`}
        more={[
          canCancel && {
            label: 'Cancel budget request',
            danger: true,
            confirm: {
              title: `Cancel ${row.number}?`,
              body:
                row.status === 'PENDING_APPROVAL'
                  ? 'The approval request is withdrawn with it, and the approvers are told.'
                  : row.status === 'APPROVED'
                    ? 'Nothing has been released, so nothing needs to come back.'
                    : 'Nothing has been approved or released yet.',
              confirmLabel: 'Cancel budget request',
              reason: 'optional',
              reasonLabel: 'Why? Kept on the request',
              onConfirm: cancel,
            },
          },
          (row.status === 'DRAFT' || row.status === 'CANCELLED') &&
            can('gops.budget_requests.delete') && {
              label: 'Delete',
              danger: true,
              confirm: {
                title: `Delete ${row.number}?`,
                body: `This ${row.status === 'CANCELLED' ? 'cancelled request' : 'draft'} goes for good. Its number is not reused.`,
                confirmLabel: 'Delete',
                onConfirm: remove,
              },
            },
        ]}
        modify={canModify ? `/g-ops/budget-requests/${row.id}/edit` : undefined}
        confirm={confirm}
      />

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
      <DecisionNote documentType="budget_request" documentId={row.id} reloadToken={reload} />
      {row.status !== 'DRAFT' && <DocumentApproval documentType="budget_request" documentId={row.id} reloadToken={reload} />}

      <ErrorBox error={error} />

      {row.status === 'DRAFT' && <div className="alert info">A draft. Nothing happens until it is submitted for approval.</div>}
      {row.status === 'PENDING_APPROVAL' && (
        <div className="alert info">Waiting for approval — the Approval panel says with whom. Nothing is charged to the project until it is liquidated.</div>
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

      {row.items && row.items.length > 0 && (
        <div className="card">
          <h3 className="card-title">Breakdown</h3>
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>#</th>
                  <th>Item and description</th>
                  <th className="right">Qty</th>
                  <th>Unit</th>
                  <th className="right">Unit cost</th>
                  <th className="right">Amount</th>
                </tr>
              </thead>
              <tbody>
                {row.items.map((i, n) => (
                  <tr key={i.id}>
                    <td className="mono">{n + 1}</td>
                    <td>
                      <strong>{i.name}</strong>
                      {i.description && <div className="faint">{i.description}</div>}
                    </td>
                    <td className="right mono">{i.quantity.toLocaleString('en-PH', { maximumFractionDigits: 3 })}</td>
                    <td>{i.unit}</td>
                    <td className="right mono">{formatMoney(i.unitCost)}</td>
                    <td className="right mono">{formatMoney(i.amount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

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
    </div>
  );
}
