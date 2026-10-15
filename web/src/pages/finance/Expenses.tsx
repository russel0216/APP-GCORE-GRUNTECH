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
import { RecordPaymentModal, paymentLink, useTeams } from './Receivables';
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
  /** The claimant's team, else their department. */
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
 * Date of reimburse, Requester, Team (else department), Project / Purpose,
 * Amount, Status in his words (TL Approval, Back Support, Checking, FM
 * Approval, CEO Approval, For Release, Paid), under the cards Sum of all
 * reimbursements, Pending process, For release and Total paid out.
 * Liquidations are the same document and stay in the list (Kind).
 */
export function Expenses() {
  const { can } = useAuth();
  const navigate = useNavigate();
  const [filing, setFiling] = useState(false);
  const [reload, setReload] = useState(0);
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
        reloadToken={reload}
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
            <button className="btn btn-primary btn-sm" onClick={() => setFiling(true)}>
              + Add reimbursement
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
 * advance or a budget request (project cash). With `existing`, modifying a
 * draft one (`PUT /expense-claims/:id`): the same form, holding the claim.
 *
 * A liquidation takes its project and budget line from what it accounts for
 * and cannot change them: the cost lands where it was approved to land. A
 * modified liquidation keeps what it accounts for — the server refuses
 * anything else.
 */
export function NewClaimModal({
  advance: advanceProp,
  budgetRequest,
  existing,
  canSubmit = true,
  onClose,
  onCreated,
}: {
  advance?: LiquidatingAdvance;
  budgetRequest?: LiquidatingAdvance;
  /** A draft claim to modify. */
  existing?: Claim;
  /** Only the claimant (or a super admin) submits; finance modifying somebody's draft only saves. */
  canSubmit?: boolean;
  onClose: () => void;
  onCreated: (id: string) => void;
}) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [jobs, setJobs] = useState<{ id: string; number: string; name: string }[]>([]);
  const [categories, setCategories] = useState<{ id: string; name: string }[]>([]);
  // What the receipts account for, whichever it is; the form reads one thing.
  // A draft liquidation being modified names it on the claim itself.
  const existingSource = existing ? existing.advance ?? existing.budgetRequest : null;
  const advance: LiquidatingAdvance | undefined =
    advanceProp ??
    budgetRequest ??
    (existing && existingSource
      ? {
          id: existingSource.id,
          number: existingSource.number,
          amountReleased: existingSource.amountReleased,
          purpose: existing.purpose,
          job: existing.job,
          costCategory: existing.costCategory,
        }
      : undefined);
  const liquidating = !!advance;
  const cashWord = (existing ? !!existing.advance : !!advanceProp) ? 'advance' : 'budget request';

  const today = todayLocal();
  const [form, setForm] = useState({
    claimDate: existing?.claimDate.slice(0, 10) ?? today,
    purpose: existing?.purpose ?? (advance ? `Liquidation of ${advance.number} — ${advance.purpose}` : ''),
    jobId: existing?.job?.id ?? '',
    costCategoryId: existing?.costCategory?.id ?? '',
  });
  const [lines, setLines] = useState(
    existing
      ? existing.lines.map((l) => ({
          spentOn: l.spentOn.slice(0, 10),
          description: l.description,
          category: l.category ?? '',
          receiptNo: l.receiptNo ?? '',
          vendor: l.vendor ?? '',
          amount: l.amount,
        }))
      : [{ spentOn: today, description: '', category: '', receiptNo: '', vendor: '', amount: 0 }],
  );

  useEffect(() => {
    if (liquidating) return;
    // Not /jobs/lookup: naming the project you spent money on is not the same
    // right as project-management access, and the filing roles hold none.
    api
      .get<{ jobs: typeof jobs; categories: typeof categories }>('/expense-claims/chargeable')
      .then((r) => {
        setJobs(r.jobs);
        setCategories(r.categories);
      })
      .catch(() => {});
  }, [liquidating]);

  // Receipts and supporting papers, picked here and filed with the save — so
  // the checker sees them from the first step (the owner's call: "at the
  // bottom can have an attachment for early approval or checking").
  const [files, setFiles] = useState<File[]>([]);
  const total = lines.reduce((s, l) => s + (l.amount || 0), 0);
  const missingReceipts = lines.filter((l) => l.description.trim() && !l.receiptNo.trim()).length;
  const difference = advance ? Math.round((total - advance.amountReleased) * 100) / 100 : 0;

  async function create(submitNow: boolean) {
    setBusy(true);
    setError(null);
    const body = {
      claimDate: form.claimDate,
      purpose: form.purpose,
      advanceId: existing ? existing.advance?.id ?? null : advanceProp?.id ?? null,
      budgetRequestId: existing ? existing.budgetRequest?.id ?? null : budgetRequest?.id ?? null,
      jobId: advance ? advance.job?.id ?? null : form.jobId || null,
      costCategoryId: advance ? advance.costCategory?.id ?? null : form.jobId ? form.costCategoryId || null : null,
      lines: lines
        .filter((l) => l.description.trim() && l.amount > 0)
        .map((l) => ({
          spentOn: l.spentOn,
          description: l.description,
          category: l.category || null,
          receiptNo: l.receiptNo || null,
          vendor: l.vendor.trim() || null,
          amount: l.amount,
        })),
    };
    try {
      const saved = existing
        ? await api.put<{ id: string }>(`/expense-claims/${existing.id}`, body)
        : await api.post<{ id: string }>('/expense-claims', body);
      if (files.length) {
        const form = new FormData();
        for (const f of files) form.append('files', f);
        try {
          await api.post(`/attachments/expense_claim/${saved.id}`, form);
        } catch {
          toast('error', 'Saved, but the attachments could not be filed — add them on the claim');
        }
      }
      if (submitNow) await api.post(`/expense-claims/${saved.id}/submit`);
      toast('ok', submitNow ? 'Submitted for approval' : existing ? 'Saved' : 'Saved as a draft');
      onCreated(saved.id);
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  }

  const valid = form.purpose.trim().length >= 3 && total > 0 && (advance || !form.jobId || !!form.costCategoryId);

  return (
    <Modal
      title={
        existing
          ? `Modify ${liquidating ? 'liquidation' : 'expense claim'} ${existing.number}`
          : advance
            ? `Liquidate ${advance.number}`
            : 'New reimbursement'
      }
      onClose={onClose}
      wide
      footer={
        <ModalFoot onCancel={onClose} busy={busy}>
          <button
            className={canSubmit ? 'btn' : 'btn btn-primary'}
            onClick={() => create(false)}
            disabled={busy || !valid}
          >
            {existing ? 'Save' : 'Save draft'}
          </button>
          {canSubmit && (
            <button
              className="btn btn-primary"
              onClick={() => create(true)}
              disabled={busy || !valid || missingReceipts > 0}
            >
              {busy ? 'Submitting…' : 'Submit for approval'}
            </button>
          )}
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
              <th>Company / receipt</th>
              <th>Item / purpose</th>
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
                    <div className="fin-line-stack">
                      <input
                        aria-label={`Line ${i + 1} company`}
                        value={l.vendor}
                        onChange={(e) => update({ vendor: e.target.value })}
                        placeholder="Company / store"
                      />
                      <input
                        aria-label={`Line ${i + 1} receipt number`}
                        value={l.receiptNo}
                        onChange={(e) => update({ receiptNo: e.target.value })}
                        placeholder="OR / SI no."
                      />
                    </div>
                  </td>
                  <td>
                    <div className="fin-line-stack">
                      <input
                        aria-label={`Line ${i + 1} item or purpose`}
                        value={l.description}
                        onChange={(e) => update({ description: e.target.value })}
                        placeholder="Item bought, or what it was for"
                      />
                      <input
                        aria-label={`Line ${i + 1} kind`}
                        value={l.category}
                        onChange={(e) => update({ category: e.target.value })}
                        placeholder="Kind: fare, meals, materials…"
                      />
                    </div>
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
              <th colSpan={3} className="right">
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
          setLines([...lines, { spentOn: today, description: '', category: '', receiptNo: '', vendor: '', amount: 0 }])
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

      <h4 className="fin-section-title">Attachments</h4>
      <p className="faint fin-flush">
        The receipts and anything that supports them — photos or scans, PDF or images. They go with the{' '}
        {liquidating ? 'liquidation' : 'claim'}, so whoever checks it sees them from the first step.
        {existing ? ' Files already on it stay; add more here or on its page.' : ''}
      </p>
      <input
        type="file"
        multiple
        accept="image/*,application/pdf"
        aria-label="Attach receipts"
        onChange={(e) => {
          const picked = Array.from(e.target.files ?? []);
          setFiles((cur) => [...cur, ...picked]);
          e.target.value = '';
        }}
      />
      {files.length > 0 && (
        <ul className="fin-files">
          {files.map((f, i) => (
            <li key={`${f.name}-${i}`}>
              <span>{f.name}</span>
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => setFiles(files.filter((_, j) => j !== i))}>
                Remove
              </button>
            </li>
          ))}
        </ul>
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
  const navigate = useNavigate();
  const { me, can } = useAuth();
  const [row, setRow] = useState<Claim | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [paying, setPaying] = useState(false);
  const [editing, setEditing] = useState(false);
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
    setEditing(true);
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
        modify={canModify ? () => setEditing(true) : undefined}
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

      {editing && (
        <NewClaimModal
          existing={row}
          canSubmit={mine}
          onClose={() => setEditing(false)}
          onCreated={() => {
            setEditing(false);
            setReload((r) => r + 1);
            load();
          }}
        />
      )}

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
