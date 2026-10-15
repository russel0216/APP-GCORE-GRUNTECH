import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { commissionFigures } from '../../lib/commission';
import { DataList, type Column } from '../../components/DataList';
import { RecordHeader } from '../../components/RecordHeader';
import { useConfirm } from '../../components/Confirm';
import { ApprovalStepper, DocumentApproval, DecisionNote, previewSteps } from '../../components/ApprovalStepper';
import { Attachments } from '../../components/Attachments';
import { Stat } from '../../components/charts';
import { NumberInput } from '../../components/NumberInput';
import { PersonSelect, usePeople } from '../../components/People';
import { useBackLink, useUnsavedChanges } from '../../components/Navigation';
import { ErrorBox, Field, Loading, StatusBadge, formatDate, formatMoney, useToast, type Tone } from '../../components/ui';

/**
 * COMMISSIONS (2026-10-16, the owner's "Commission Request System"): a sales
 * order's commission, raised once the order is fully collected, split among
 * the people who earned it, approved by the Finance Manager then the CEO /
 * President, and paid by finance. The arithmetic is `lib/commission.ts`, the
 * API's own copy. The API is `/api/commissions`.
 */

export const COMMISSION_TONES: Record<string, Tone> = {
  DRAFT: '',
  PENDING_APPROVAL: 'warn',
  APPROVED: 'info',
  PAID: 'ok',
  CANCELLED: 'danger',
};

const STATUSES = [
  { value: 'DRAFT', label: 'Draft' },
  { value: 'PENDING_APPROVAL', label: 'Pending approval' },
  { value: 'APPROVED', label: 'Approved — to pay' },
  { value: 'PAID', label: 'Paid' },
  { value: 'CANCELLED', label: 'Cancelled' },
];

interface Named {
  id: string;
  name: string;
}

interface Row {
  id: string;
  number: string;
  status: string;
  stage: string | null;
  requestedBy: Named;
  team: { id: string; code: string } | null;
  salesOrder: { id: string; number: string };
  customer: Named;
  commissionType: string;
  people: number;
  grossCommission: number;
  totalNet: number;
  createdAt: string;
}

interface Summary {
  paid: number;
  paidCount: number;
  pending: number;
  pendingCount: number;
  active: number;
  teams: number;
  avgMarginPct: number | null;
}

const stageOf = (status: string, stage: string | null) => (status === 'PENDING_APPROVAL' && stage ? stage : undefined);

/** G-FIN › Money out › Commissions — the register. */
export function Commissions() {
  const navigate = useNavigate();
  const { can } = useAuth();
  const columns: Column<Row>[] = [
    { key: 'number', label: 'RFC No.', sortKey: 'number', render: (r) => <span className="mono">{r.number}</span> },
    { key: 'requestedBy', label: 'Requester', render: (r) => r.requestedBy.name },
    { key: 'team', label: 'Team', render: (r) => r.team?.code ?? '—' },
    {
      key: 'salesOrder',
      label: 'SO No.',
      render: (r) => (
        <>
          <Link to={`/g-ops/sales-orders/${r.salesOrder.id}`} className="mono" onClick={(e) => e.stopPropagation()}>
            {r.salesOrder.number}
          </Link>
          <div className="faint">{r.customer.name}</div>
        </>
      ),
    },
    { key: 'createdAt', label: 'Date requested', sortKey: 'createdAt', render: (r) => formatDate(r.createdAt) },
    {
      key: 'amount',
      label: 'Amount',
      align: 'right',
      sortKey: 'totalNet',
      render: (r) => (
        <>
          {formatMoney(r.grossCommission)}
          <div className="faint">{formatMoney(r.totalNet)} net</div>
        </>
      ),
    },
    {
      key: 'status',
      label: 'Status',
      sortKey: 'status',
      render: (r) => <StatusBadge status={r.status} extra={COMMISSION_TONES} label={stageOf(r.status, r.stage)} />,
    },
  ];
  return (
    <div>
      <div className="page-head">
        <h1>Commissions</h1>
      </div>
      <DataList<Row>
        listKey="commissions"
        endpoint="/commissions"
        printPath="/api/commissions/pdf"
        reportPath={can('gfin.reports.view_all') && can('gfin.commissions.view_all') ? '/g-fin/reports?kind=commissions' : undefined}
        actions={
          can('gfin.commissions.create') ? (
            <Link className="btn btn-primary btn-sm" to="/g-fin/commissions/new">
              + New Commission Request
            </Link>
          ) : undefined
        }
        columns={columns}
        rowKey={(r) => r.id}
        scoped
        selectable
        searchPlaceholder="RFC no., requester, SO no., customer, OR no.…"
        onRowClick={(r) => navigate(`/g-fin/commissions/${r.id}`)}
        emptyTitle="No commission requests"
        emptyHint="A commission is raised on a sales order once it is fully collected."
        filters={[
          { key: 'status', label: 'Status', options: STATUSES },
          { key: 'dateFrom', toKey: 'dateTo', label: 'Requested', type: 'dateRange' },
        ]}
        summary={(raw) => {
          const sum = raw as unknown as Summary | undefined;
          if (!sum) return null;
          return (
            <>
              <Stat label="Total commissions paid" value={formatMoney(sum.paid)} figure accent="ok" sub={`${sum.paidCount} paid`} to="/g-fin/commissions?status=PAID" />
              <Stat
                label="Pending approval"
                value={formatMoney(sum.pending)}
                figure
                accent={sum.pendingCount > 0 ? 'warn' : undefined}
                sub={`${sum.pendingCount} request${sum.pendingCount === 1 ? '' : 's'}`}
                to="/g-fin/commissions?status=PENDING_APPROVAL"
              />
              <Stat label="Active requests" value={String(sum.active)} figure sub="draft, pending or to pay" />
              <Stat label="Sales teams eligible" value={String(sum.teams)} figure sub="teams with a commission" />
              <Stat label="Avg. margin rate" value={sum.avgMarginPct == null ? '—' : `${sum.avgMarginPct.toFixed(2)}%`} figure sub="margin over the net of VAT" />
            </>
          );
        }}
      />
    </div>
  );
}

// ── The editor ───────────────────────────────────────────────────────────────

interface Advance {
  id: string;
  number: string;
  balance: number;
  reserved: number;
  free: number;
}

interface SourcePerson {
  id: string;
  name: string;
  position: string | null;
  roles: string[];
  openAdvances: Advance[];
}

interface Source {
  salesOrder: { id: string; number: string; orderDate: string; status: string };
  quotation: { id: string; number: string; subject: string | null };
  customer: Named;
  job: { id: string; number: string; name: string } | null;
  salesperson: Named | null;
  team: { id: string; code: string; name: string } | null;
  totalAmount: number;
  vatAmount: number;
  netOfVat: number;
  totalCost: number;
  collectedAmount: number;
  margin: number;
  fullyCollected: boolean;
  orNumbers: string[];
  collectedOn: string | null;
  problem: string | null;
  mayRaise: boolean;
  people: SourcePerson[];
  advances: Record<string, Advance[]>;
}

interface ShareLine {
  userId: string;
  name: string;
  position: string;
  /** Percent, as typed: 60 = 60%. */
  sharePct: number;
  taxPct: number;
  caDeduction: number;
  cashAdvanceId: string | null;
}

export interface CommissionDetail {
  id: string;
  number: string;
  status: string;
  stage: string | null;
  salesOrder: { id: string; number: string; orderDate: string };
  quotation: { id: string; number: string; subject: string | null };
  customer: Named;
  job: { id: string; number: string; name: string } | null;
  requestedBy: Named;
  salesperson: Named | null;
  team: { id: string; code: string; name: string } | null;
  commissionType: 'INDIVIDUAL' | 'GROUP';
  ratePct: number;
  totalAmount: number;
  netOfVat: number;
  vatAmount: number;
  totalCost: number;
  margin: number;
  collectedAmount: number;
  grossCommission: number;
  totalTax: number;
  totalCa: number;
  totalNet: number;
  orNumbers: string | null;
  collectedOn: string | null;
  notes: string | null;
  cancelReason: string | null;
  approvedAt: string | null;
  paidAt: string | null;
  createdAt: string;
  updatedAt: string;
  shares: {
    id: string;
    user: Named & { position: string | null };
    position: string | null;
    sharePct: number;
    share: number;
    taxPct: number;
    tax: number;
    caDeduction: number;
    cashAdvance: { id: string; number: string } | null;
    net: number;
    payment: { id: string; number: string } | null;
    openAdvances: Advance[];
  }[];
  invoices: { id: string; number: string; siNumber: string | null; status: string; netCollectible: number; amountCollected: number }[];
  collections: { id: string; number: string; orNumber: string | null; paymentDate: string; invoice: string; amount: number }[];
  fullyCollected: boolean;
  canEdit: boolean;
  canSubmit: boolean;
  canWithdraw: boolean;
  canCancel: boolean;
  canDelete: boolean;
  canPay: boolean;
  approvalRoute: { name: string; steps: { name: string; held?: boolean; approvers: { id: string; name: string }[] }[] } | null;
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const pct6 = (n: number) => Math.round(n * 10000) / 1_000_000;

/**
 * `/g-fin/commissions/new?salesOrder=` and `/g-fin/commissions/:id/edit` —
 * the RFC form, a page: the sales order (fully collected ones only), its
 * breakdown read-only with the owner's banner, the commission type and rate,
 * and the beneficiaries with their share, tax and cash advance deduction.
 * Save at the top and the foot; Submit for approval saves first.
 */
export function CommissionEditor() {
  const { id } = useParams<{ id: string }>();
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const toast = useToast();
  const { me } = useAuth();
  const [existing, setExisting] = useState<CommissionDetail | null>(null);
  const [orders, setOrders] = useState<{ id: string; number: string; customer: string; orderDate: string }[] | null>(null);
  const [orderId, setOrderId] = useState(params.get('salesOrder') ?? '');
  const [source, setSource] = useState<Source | null>(null);
  const [type, setType] = useState<'INDIVIDUAL' | 'GROUP'>('INDIVIDUAL');
  const [rate, setRate] = useState(10);
  const [notes, setNotes] = useState('');
  const [lines, setLines] = useState<ShareLine[]>([]);
  const [adding, setAdding] = useState(false);
  const [pick, setPick] = useState('');
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const { people } = usePeople();
  useUnsavedChanges(dirty);
  useBackLink(id ? `/g-fin/commissions/${id}` : null, existing ? `Back to ${existing.number}` : null);

  useEffect(() => {
    if (!id) return;
    api
      .get<CommissionDetail>(`/commissions/${id}`)
      .then((row) => {
        setExisting(row);
        setOrderId(row.salesOrder.id);
        setType(row.commissionType);
        setRate(round2(row.ratePct * 100));
        setNotes(row.notes ?? '');
        setLines(
          row.shares.map((s) => ({
            userId: s.user.id,
            name: s.user.name,
            position: s.position ?? '',
            sharePct: round2(s.sharePct * 100),
            taxPct: round2(s.taxPct * 100),
            caDeduction: s.caDeduction,
            cashAdvanceId: s.cashAdvance?.id ?? null,
          })),
        );
      })
      .catch(setError);
  }, [id]);

  useEffect(() => {
    if (id) return;
    api.get<typeof orders>('/commissions/eligible-orders').then(setOrders).catch(setError);
  }, [id]);

  const extraIds = lines.map((l) => l.userId).join(',');
  useEffect(() => {
    if (!orderId) return setSource(null);
    api
      .get<Source>(`/commissions/source?salesOrderId=${orderId}${id ? `&requestId=${id}` : ''}${extraIds ? `&userIds=${extraIds}` : ''}`)
      .then((s) => {
        setSource(s);
        // A new request starts with the quotation's owner, at 100%.
        setLines((cur) => {
          if (cur.length || id) return cur;
          const first = s.people.find((p) => p.roles.includes('Quotation owner')) ?? s.people[0];
          return first ? [{ userId: first.id, name: first.name, position: first.position ?? first.roles.join(', '), sharePct: 100, taxPct: 10, caDeduction: 0, cashAdvanceId: null }] : cur;
        });
      })
      .catch(setError);
  }, [orderId, id, extraIds]);

  const advancesOf = useCallback(
    (userId: string): Advance[] => source?.people.find((p) => p.id === userId)?.openAdvances ?? source?.advances[userId] ?? [],
    [source],
  );

  const figures = useMemo(
    () =>
      source
        ? commissionFigures({
            totalAmount: source.totalAmount,
            vatAmount: source.vatAmount,
            totalCost: source.totalCost,
            collectedAmount: source.collectedAmount,
            ratePct: pct6(rate),
            shares: lines.map((l) => ({ sharePct: pct6(l.sharePct), taxPct: pct6(l.taxPct), caDeduction: l.caDeduction })),
          })
        : null,
    [source, rate, lines],
  );

  function change(fn: () => void) {
    fn();
    setDirty(true);
  }
  function setLine(i: number, patch: Partial<ShareLine>) {
    change(() => setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...patch } : l))));
  }
  function addPerson(userId: string, name: string, position: string) {
    if (!userId || lines.some((l) => l.userId === userId)) return;
    change(() => {
      setLines((ls) => [...ls, { userId, name, position, sharePct: 0, taxPct: 10, caDeduction: 0, cashAdvanceId: null }]);
      setType('GROUP');
    });
    setAdding(false);
    setPick('');
  }

  const problems: string[] = [];
  if (!orderId) problems.push('choose the sales order');
  if (!(rate > 0)) problems.push('give the commission rate');
  if (!lines.length) problems.push('add the person the commission is for');
  if (figures && lines.length && !figures.sharesComplete) problems.push('the shares must add up to 100%');
  if (type === 'INDIVIDUAL' && lines.length > 1) problems.push('an individual commission is for one person — choose Group allocation');
  lines.forEach((l, i) => {
    if (l.caDeduction > 0) {
      const free = advancesOf(l.userId).find((a) => a.id === l.cashAdvanceId) ?? advancesOf(l.userId)[0];
      if (!free) problems.push(`${l.name} has no open cash advance to deduct from`);
      else if (l.caDeduction > free.free + 0.005) problems.push(`${l.name}'s deduction is more than the ${formatMoney(free.free)} left on ${free.number}`);
    }
    if (figures && figures.shares[i]?.net < -0.004) problems.push(`${l.name}'s deductions are more than their share`);
  });

  async function save(andSubmit: boolean) {
    if (problems.length) return setError(new Error(`Not saved yet — ${problems.join('; ')}.`));
    setBusy(true);
    setError(null);
    try {
      const body = {
        salesOrderId: orderId,
        commissionType: type,
        ratePct: pct6(rate),
        notes: notes || null,
        version: existing?.updatedAt,
        shares: lines.map((l) => ({
          userId: l.userId,
          position: l.position || null,
          sharePct: pct6(l.sharePct),
          taxPct: pct6(l.taxPct),
          caDeduction: l.caDeduction,
          cashAdvanceId: l.caDeduction > 0 ? (l.cashAdvanceId ?? advancesOf(l.userId)[0]?.id ?? null) : null,
        })),
      };
      const saved = existing ? await api.put<CommissionDetail>(`/commissions/${existing.id}`, body) : await api.post<CommissionDetail>('/commissions', body);
      setDirty(false);
      if (andSubmit) {
        try {
          await api.post(`/commissions/${saved.id}/submit`);
          toast('ok', `${saved.number} sent for approval`);
        } catch (err) {
          toast('error', `${saved.number} saved as a draft — ${err instanceof Error ? err.message : 'it could not be submitted'}`);
        }
      } else toast('ok', existing ? 'Saved' : `${saved.number} saved as a draft`);
      navigate(`/g-fin/commissions/${saved.id}`);
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  }

  if (id && !existing) return error ? <ErrorBox error={error} /> : <Loading />;
  if (existing && !existing.canEdit) {
    return (
      <div className="card">
        <p className="muted">{existing.number} is not a draft you may change. A pending request is pulled back to draft from ⋯ on its page.</p>
      </div>
    );
  }

  const actions = (
    <>
      <button type="button" className="btn" onClick={() => void save(false)} disabled={busy}>
        {busy ? 'Saving…' : 'Save'}
      </button>
      <button type="button" className="btn btn-primary" onClick={() => void save(true)} disabled={busy || !!source?.problem}>
        Submit for approval
      </button>
    </>
  );
  const suggested = (source?.people ?? []).filter((p) => !lines.some((l) => l.userId === p.id));

  return (
    <div className="stack">
      <section className="card qe-card">
        <div className="qe-head">
          <div>
            <h1 className="qe-heading">{existing ? `Modify commission request ${existing.number}` : 'New commission request'}</h1>
            <p className="muted qe-lead">Sales personnel / group commission form. The number is issued on the first save.</p>
          </div>
          <div className="row qe-actions">{actions}</div>
        </div>
        <ErrorBox error={error} />
        {source?.problem && <div className="alert warn">{source.problem}</div>}
        {source && !source.mayRaise && !existing && <div className="alert warn">Only the salesperson who holds the sales order, or their Team Leader, can raise its commission.</div>}
        <div className="qe-rows">
          <Field label="Sales order (SO No.)" required hint={existing ? 'The order a commission is on does not change.' : 'Fully collected issued orders with no commission yet.'}>
            {existing ? (
              <input value={existing.salesOrder.number} disabled />
            ) : (
              <select
                value={orderId}
                onChange={(e) => {
                  change(() => {
                    setOrderId(e.target.value);
                    setLines([]);
                  });
                  setParams(e.target.value ? { salesOrder: e.target.value } : {}, { replace: true });
                }}
              >
                <option value="">— choose —</option>
                {orderId && !orders?.some((o) => o.id === orderId) && source && <option value={orderId}>{source.salesOrder.number}</option>}
                {(orders ?? []).map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.number} — {o.customer}
                  </option>
                ))}
              </select>
            )}
          </Field>
        </div>
        {source && (
          <dl className="kv">
            <dt>Company name</dt>
            <dd>{source.customer.name}</dd>
            <dt>Sales personnel</dt>
            <dd>{source.salesperson?.name ?? '—'}{source.team ? ` · ${source.team.code}` : ''}</dd>
            <dt>Sales order date</dt>
            <dd>{formatDate(source.salesOrder.orderDate)}</dd>
            <dt>Date of collection</dt>
            <dd>{source.collectedOn ? formatDate(source.collectedOn) : '—'}</dd>
            <dt>OR No.</dt>
            <dd className="mono">{source.orNumbers.join(', ') || '—'}</dd>
            {source.job && (
              <>
                <dt>Project</dt>
                <dd>
                  <span className="mono">{source.job.number}</span> {source.job.name}
                </dd>
              </>
            )}
          </dl>
        )}
      </section>

      {source && figures && (
        <section className="card">
          <h2 className="card-title">Sales order financial breakdown</h2>
          <dl className="kv">
            <dt>Total amount</dt>
            <dd>{formatMoney(source.totalAmount)}</dd>
            <dt>Amount net of VAT</dt>
            <dd>{formatMoney(figures.netOfVat)}</dd>
            <dt>VAT amount</dt>
            <dd>{formatMoney(source.vatAmount)}</dd>
            <dt>Total cost</dt>
            <dd>{formatMoney(source.totalCost)}</dd>
            <dt>Margin</dt>
            <dd>{formatMoney(round2(figures.netOfVat - source.totalCost))}</dd>
            <dt>Collected amount</dt>
            <dd>{formatMoney(source.collectedAmount)}</dd>
          </dl>
          <div className="alert info">
            Actual margin = total collected ({formatMoney(source.collectedAmount)}) − VAT ({formatMoney(source.vatAmount)}) − total cost ({formatMoney(source.totalCost)}) ={' '}
            <b>{formatMoney(figures.margin)}</b>
          </div>
        </section>
      )}

      {source && figures && (
        <section className="card">
          <h2 className="card-title">Commission beneficiaries and deductions</h2>
          <p className="muted">Total net commission = commission share − tax deduction − cash advance.</p>
          <div className="grid-2">
            <Field label="Commission type">
              <select value={type} onChange={(e) => change(() => setType(e.target.value as 'INDIVIDUAL' | 'GROUP'))}>
                <option value="INDIVIDUAL">Individual</option>
                <option value="GROUP">Group allocation (multi-person)</option>
              </select>
            </Field>
            <Field label="Total commission rate" required hint={`Total gross commission: ${formatMoney(figures.grossCommission)}`}>
              <NumberInput kind="percent" min={0} max={100} value={rate} onChange={(e) => change(() => setRate(Number(e.target.value)))} />
            </Field>
          </div>
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Name</th>
                  <th className="num">Share %</th>
                  <th className="num">Comm. share</th>
                  <th className="num">Tax %</th>
                  <th className="num">Tax deduction</th>
                  <th className="num">CA deduction</th>
                  <th className="num">Total net comm.</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {lines.map((l, i) => {
                  const f = figures.shares[i];
                  const advances = advancesOf(l.userId);
                  const chosen = advances.find((a) => a.id === l.cashAdvanceId) ?? advances[0];
                  return (
                    <tr key={l.userId}>
                      <td>
                        <b>{l.name}</b>
                        <div className="faint">{l.position || '—'}</div>
                      </td>
                      <td className="num">
                        <NumberInput kind="percent" min={0} max={100} value={l.sharePct} onChange={(e) => setLine(i, { sharePct: Number(e.target.value) })} aria-label={`${l.name} share percent`} />
                      </td>
                      <td className="num">{formatMoney(f?.share ?? 0)}</td>
                      <td className="num">
                        <NumberInput kind="percent" min={0} max={100} value={l.taxPct} onChange={(e) => setLine(i, { taxPct: Number(e.target.value) })} aria-label={`${l.name} tax percent`} />
                      </td>
                      <td className="num">{formatMoney(f?.tax ?? 0)}</td>
                      <td className="num">
                        {advances.length ? (
                          <>
                            <NumberInput
                              kind="money"
                              min={0}
                              max={chosen?.free}
                              value={l.caDeduction}
                              onChange={(e) => setLine(i, { caDeduction: Number(e.target.value), cashAdvanceId: l.cashAdvanceId ?? chosen?.id ?? null })}
                              aria-label={`${l.name} cash advance deduction`}
                            />
                            {advances.length > 1 ? (
                              <select value={chosen?.id ?? ''} onChange={(e) => setLine(i, { cashAdvanceId: e.target.value })} aria-label={`${l.name} cash advance`}>
                                {advances.map((a) => (
                                  <option key={a.id} value={a.id}>
                                    {a.number} — {formatMoney(a.free)} open
                                  </option>
                                ))}
                              </select>
                            ) : (
                              <div className="faint">
                                {chosen!.number}: {formatMoney(chosen!.free)} open
                              </div>
                            )}
                          </>
                        ) : (
                          <span className="faint">No open advance</span>
                        )}
                      </td>
                      <td className="num">
                        <b>{formatMoney(f?.net ?? 0)}</b>
                      </td>
                      <td>
                        <button type="button" className="btn btn-sm" onClick={() => change(() => setLines((ls) => ls.filter((_, j) => j !== i)))}>
                          Remove
                        </button>
                      </td>
                    </tr>
                  );
                })}
                <tr>
                  <td>
                    <b>Totals</b>
                  </td>
                  <td className="num">{round2(lines.reduce((s, l) => s + l.sharePct, 0))}%</td>
                  <td className="num">
                    <b>{formatMoney(figures.totalShare)}</b>
                  </td>
                  <td />
                  <td className="num">
                    <b>{formatMoney(figures.totalTax)}</b>
                  </td>
                  <td className="num">
                    <b>{formatMoney(figures.totalCa)}</b>
                  </td>
                  <td className="num">
                    <b>{formatMoney(figures.totalNet)}</b>
                  </td>
                  <td />
                </tr>
              </tbody>
            </table>
          </div>
          {adding ? (
            <div className="card-foot stack">
              {suggested.length > 0 && (
                <>
                  <p className="muted">On this deal:</p>
                  <div className="row">
                    {suggested.map((p) => (
                      <button key={p.id} type="button" className="btn btn-sm" onClick={() => addPerson(p.id, p.name, p.position ?? p.roles.join(', '))}>
                        {p.name} — {p.roles.join(', ')}
                      </button>
                    ))}
                  </div>
                </>
              )}
              <Field label="Someone else">
                <PersonSelect value={pick} onChange={setPick} people={people.filter((p) => !lines.some((l) => l.userId === p.id))} self={me?.user.id} />
              </Field>
              <div className="row">
                <button type="button" className="btn btn-sm" onClick={() => setAdding(false)}>
                  Cancel
                </button>
                <button
                  type="button"
                  className="btn btn-sm btn-primary"
                  disabled={!pick}
                  onClick={() => {
                    const p = people.find((x) => x.id === pick);
                    if (p) addPerson(p.id, p.name, p.position ?? '');
                  }}
                >
                  Add
                </button>
              </div>
            </div>
          ) : (
            <div className="card-foot">
              <button type="button" className="btn btn-sm" onClick={() => setAdding(true)}>
                + Add person to group split
              </button>
            </div>
          )}
        </section>
      )}

      {source && (
        <section className="card">
          <Field label="Notes for the approvers and finance">
            <textarea rows={2} value={notes} onChange={(e) => change(() => setNotes(e.target.value))} />
          </Field>
          <p className="muted">Workflow target: Finance Manager, then the CEO / President — from the approval route, never picked on the form.</p>
        </section>
      )}

      <div className="row qe-foot">{actions}</div>
    </div>
  );
}

// ── The record ───────────────────────────────────────────────────────────────

/** `/g-fin/commissions/:id` — where the approval notification lands. No web Guard: the API decides. */
export function CommissionPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const toast = useToast();
  const { can } = useAuth();
  const confirm = useConfirm();
  const [row, setRow] = useState<CommissionDetail | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [reload, setReload] = useState(0);
  const [paying, setPaying] = useState(false);
  const [pay, setPay] = useState({ method: 'BANK_TRANSFER', paymentDate: '', reference: '' });

  const load = useCallback(async () => {
    try {
      setRow(await api.get<CommissionDetail>(`/commissions/${id}`));
    } catch (err) {
      setError(err);
    }
  }, [id]);
  useEffect(() => {
    load();
  }, [load]);

  if (error && !row) return <ErrorBox error={error} />;
  if (!row) return <Loading />;
  const draft = row.status === 'DRAFT';
  const done = () => {
    setReload((r) => r + 1);
    load();
  };

  async function submit() {
    setError(null);
    try {
      await api.post(`/commissions/${id}/submit`);
      toast('ok', 'Sent for approval');
      done();
    } catch (err) {
      setError(err);
    }
  }
  async function payNow() {
    setError(null);
    try {
      await api.post(`/commissions/${id}/pay`, { method: pay.method, paymentDate: pay.paymentDate || undefined, reference: pay.reference || null });
      toast('ok', 'Paid — the vouchers are in Payments');
      setPaying(false);
      done();
    } catch (err) {
      setError(err);
    }
  }

  return (
    <div>
      <RecordHeader
        type="Commission Request"
        code={row.number}
        title={`Commission on ${row.salesOrder.number} — ${row.customer.name}`}
        status={row.status}
        statusExtra={COMMISSION_TONES}
        amount={formatMoney(row.grossCommission)}
        amountLabel="Gross commission"
        meta={
          <>
            Requested by {row.requestedBy.name} on {formatDate(row.createdAt)} ·{' '}
            <Link to={`/g-ops/sales-orders/${row.salesOrder.id}`} className="mono">
              {row.salesOrder.number}
            </Link>
          </>
        }
        actions={
          row.canSubmit ? (
            <button className="btn btn-primary" onClick={submit}>
              Submit for approval
            </button>
          ) : row.canPay ? (
            <button className="btn btn-primary" onClick={() => setPaying(true)}>
              Pay
            </button>
          ) : undefined
        }
        print={`/api/commissions/${row.id}/pdf`}
        more={[
          row.canWithdraw && {
            label: 'Pull back to draft',
            confirm: {
              title: `Pull ${row.number} back?`,
              body: 'The approval request is withdrawn and the approvers are told.',
              confirmLabel: 'Pull it back',
              onConfirm: async () => {
                await api.post(`/commissions/${row.id}/withdraw`);
                toast('ok', 'Back to draft');
                done();
              },
            },
          },
          row.canCancel && {
            label: 'Cancel request',
            danger: true,
            confirm: {
              title: `Cancel ${row.number}?`,
              body: row.status === 'PENDING_APPROVAL' ? 'The approval request is withdrawn with it.' : 'Nothing has been decided yet.',
              confirmLabel: 'Cancel request',
              reason: 'required',
              reasonLabel: 'Why? Kept on the request',
              minReason: 3,
              onConfirm: async (reason) => {
                await api.post(`/commissions/${row.id}/cancel`, { reason });
                toast('ok', 'Cancelled');
                done();
              },
            },
          },
          row.canDelete && {
            label: 'Delete',
            danger: true,
            confirm: {
              title: `Delete ${row.number}?`,
              body: 'It goes for good, with its files. Its number is not reused.',
              confirmLabel: 'Delete',
              onConfirm: async () => {
                await api.del(`/commissions/${row.id}`);
                toast('ok', 'Deleted');
                navigate('/g-fin/commissions');
              },
            },
          },
        ]}
        modify={row.canEdit ? `/g-fin/commissions/${row.id}/edit` : undefined}
        confirm={confirm}
      />

      {draft && row.approvalRoute && row.approvalRoute.steps.length > 0 && (
        <div className="qd-route">
          <span className="qd-route-label">Submit for approval sends it to</span>
          <ApprovalStepper steps={previewSteps(row.approvalRoute)} />
        </div>
      )}
      <DecisionNote documentType="commission" documentId={row.id} reloadToken={reload} />
      {!draft && row.status !== 'CANCELLED' && <DocumentApproval documentType="commission" documentId={row.id} reloadToken={reload} />}
      <ErrorBox error={error} />

      {paying && (
        <section className="card">
          <h3 className="card-title">Pay {row.number}</h3>
          <p className="muted">
            One voucher per person for their net ({formatMoney(row.totalNet)} in all); {formatMoney(row.totalCa)} is recorded as cash advance repayments.
          </p>
          <div className="grid-2">
            <Field label="Method">
              <select value={pay.method} onChange={(e) => setPay((p) => ({ ...p, method: e.target.value }))}>
                <option value="BANK_TRANSFER">Bank transfer</option>
                <option value="CASH">Cash</option>
                <option value="CHECK">Cheque</option>
                <option value="ONLINE">Online</option>
              </select>
            </Field>
            <Field label="Payment date" hint="Blank: today">
              <input type="date" value={pay.paymentDate} onChange={(e) => setPay((p) => ({ ...p, paymentDate: e.target.value }))} />
            </Field>
            <Field label="Cheque no. / reference">
              <input value={pay.reference} maxLength={120} onChange={(e) => setPay((p) => ({ ...p, reference: e.target.value }))} />
            </Field>
          </div>
          <div className="row card-foot">
            <button type="button" className="btn btn-sm" onClick={() => setPaying(false)}>
              Cancel
            </button>
            <button type="button" className="btn btn-sm btn-primary" onClick={() => void payNow()}>
              Pay {formatMoney(row.totalNet)}
            </button>
          </div>
        </section>
      )}

      {row.status === 'CANCELLED' && <div className="alert warn">Cancelled{row.cancelReason ? ` — ${row.cancelReason}` : ''}.</div>}
      {row.status === 'PAID' && <div className="alert ok">Paid{row.paidAt ? ` on ${formatDate(row.paidAt)}` : ''}.</div>}

      <div className="stack">
        <div className="grid-2">
          <section className="card">
            <h3 className="card-title">The deal</h3>
            <dl className="kv">
              <dt>Company name</dt>
              <dd>{row.customer.name}</dd>
              <dt>Sales order</dt>
              <dd>
                <Link to={`/g-ops/sales-orders/${row.salesOrder.id}`} className="mono">
                  {row.salesOrder.number}
                </Link>{' '}
                <span className="faint">{formatDate(row.salesOrder.orderDate)}</span>
              </dd>
              <dt>Quotation</dt>
              <dd>
                <Link to={`/g-ops/quotations/${row.quotation.id}`} className="mono">
                  {row.quotation.number}
                </Link>{' '}
                {row.quotation.subject}
              </dd>
              {row.job && (
                <>
                  <dt>Project</dt>
                  <dd>
                    {can('gops.projects.view_all') || can('gops.projects.view_own') ? (
                      <Link to={`/g-ops/projects/${row.job.id}`} className="mono">
                        {row.job.number}
                      </Link>
                    ) : (
                      <span className="mono">{row.job.number}</span>
                    )}{' '}
                    {row.job.name}
                  </dd>
                </>
              )}
              <dt>Sales personnel</dt>
              <dd>{row.salesperson?.name ?? '—'}</dd>
              <dt>Team</dt>
              <dd>{row.team ? `${row.team.code} — ${row.team.name}` : '—'}</dd>
              <dt>Invoices</dt>
              <dd>
                {row.invoices.map((i, n) => (
                  <span key={i.id}>
                    {n > 0 && ', '}
                    {can('gfin.ar.view_all') ? (
                      <Link to={`/g-fin/ar/${i.id}`} className="mono">
                        {i.number}
                      </Link>
                    ) : (
                      <span className="mono">{i.number}</span>
                    )}
                  </span>
                ))}
                {!row.invoices.length && '—'}
              </dd>
              <dt>Collections (OR No.)</dt>
              <dd>
                {row.collections.map((c, n) => (
                  <span key={`${c.id}-${c.invoice}`}>
                    {n > 0 && ', '}
                    {can('gfin.payments.view_all') || can('gfin.ar.view_all') ? (
                      <Link to={`/g-fin/payments/${c.id}`} className="mono">
                        {c.orNumber ?? c.number}
                      </Link>
                    ) : (
                      <span className="mono">{c.orNumber ?? c.number}</span>
                    )}{' '}
                    <span className="faint">{formatDate(c.paymentDate)}</span>
                  </span>
                ))}
                {!row.collections.length && '—'}
              </dd>
              {row.notes && (
                <>
                  <dt>Notes</dt>
                  <dd className="del-prose">{row.notes}</dd>
                </>
              )}
            </dl>
          </section>
          <section className="card">
            <h3 className="card-title">Sales order financial breakdown</h3>
            <dl className="kv">
              <dt>Total amount</dt>
              <dd>{formatMoney(row.totalAmount)}</dd>
              <dt>Amount net of VAT</dt>
              <dd>{formatMoney(row.netOfVat)}</dd>
              <dt>VAT amount</dt>
              <dd>{formatMoney(row.vatAmount)}</dd>
              <dt>Total cost</dt>
              <dd>{formatMoney(row.totalCost)}</dd>
              <dt>Collected amount</dt>
              <dd>{formatMoney(row.collectedAmount)}</dd>
              <dt>Actual margin</dt>
              <dd>
                <b>{formatMoney(row.margin)}</b>
              </dd>
              <dt>Rate</dt>
              <dd>
                {round2(row.ratePct * 100)}% · {row.commissionType === 'GROUP' ? 'Group allocation' : 'Individual'}
              </dd>
            </dl>
          </section>
        </div>

        <section className="card">
          <h3 className="card-title">Beneficiaries and deductions</h3>
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Name</th>
                  <th className="num">Share %</th>
                  <th className="num">Comm. share</th>
                  <th className="num">Tax deduction</th>
                  <th className="num">CA deduction</th>
                  <th className="num">Total net comm.</th>
                  <th>Voucher</th>
                </tr>
              </thead>
              <tbody>
                {row.shares.map((s) => (
                  <tr key={s.id}>
                    <td>
                      <b>{s.user.name}</b>
                      <div className="faint">{s.position ?? '—'}</div>
                    </td>
                    <td className="num">{round2(s.sharePct * 100)}%</td>
                    <td className="num">{formatMoney(s.share)}</td>
                    <td className="num">
                      {formatMoney(s.tax)} <span className="faint">({round2(s.taxPct * 100)}%)</span>
                    </td>
                    <td className="num">
                      {formatMoney(s.caDeduction)}
                      {s.cashAdvance && (
                        <div className="faint">
                          <Link to={`/g-fin/cash-advances/${s.cashAdvance.id}`} className="mono">
                            {s.cashAdvance.number}
                          </Link>
                        </div>
                      )}
                    </td>
                    <td className="num">
                      <b>{formatMoney(s.net)}</b>
                    </td>
                    <td>{s.payment ? <Link to={`/g-fin/payments/${s.payment.id}`} className="mono">{s.payment.number}</Link> : <span className="faint">—</span>}</td>
                  </tr>
                ))}
                <tr>
                  <td>
                    <b>Totals</b>
                  </td>
                  <td />
                  <td className="num">
                    <b>{formatMoney(row.grossCommission)}</b>
                  </td>
                  <td className="num">
                    <b>{formatMoney(row.totalTax)}</b>
                  </td>
                  <td className="num">
                    <b>{formatMoney(row.totalCa)}</b>
                  </td>
                  <td className="num">
                    <b>{formatMoney(row.totalNet)}</b>
                  </td>
                  <td />
                </tr>
              </tbody>
            </table>
          </div>
        </section>

        <Attachments
          entityType="commission_request"
          entityId={row.id}
          title="Files"
          hint={draft ? 'Printed behind the request.' : 'What the approvers were sent. Files change only on a draft.'}
          canEdit={!!row.canEdit}
        />
      </div>
    </div>
  );
}

/**
 * The "Commissions" card on a sales order's page and a project's — the
 * register's own list filtered (`?salesOrderId=` / `?jobId=`), hidden without
 * the register's right.
 */
export function CommissionsCard({ salesOrderId, jobId }: { salesOrderId?: string; jobId?: string }) {
  const { can } = useAuth();
  const allowed = can('gfin.commissions.view_all') || can('gfin.commissions.view_own');
  const [rows, setRows] = useState<Row[] | null>(null);
  useEffect(() => {
    if (!allowed) return;
    const q = salesOrderId ? `salesOrderId=${salesOrderId}` : `jobId=${jobId}`;
    api
      .get<{ rows: Row[] }>(`/commissions?${q}&scope=all&pageSize=50`)
      .then((r) => setRows(r.rows))
      .catch(() => setRows([]));
  }, [allowed, salesOrderId, jobId]);
  if (!allowed || !rows) return null;
  return (
    <section className="card">
      <div className="card-head">
        <h3 className="card-title">Commissions</h3>
        {salesOrderId && can('gfin.commissions.create') && !rows.some((r) => r.status !== 'CANCELLED') && (
          <Link className="btn btn-sm" to={`/g-fin/commissions/new?salesOrder=${salesOrderId}`}>
            + New Commission Request
          </Link>
        )}
      </div>
      {rows.length === 0 ? (
        <p className="muted">Nothing yet — a commission is raised once the sales order is fully collected.</p>
      ) : (
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>RFC No.</th>
                <th>Requester</th>
                <th>SO No.</th>
                <th className="num">Gross</th>
                <th className="num">Net</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td>
                    <Link to={`/g-fin/commissions/${r.id}`} className="mono">
                      {r.number}
                    </Link>
                  </td>
                  <td>{r.requestedBy.name}</td>
                  <td className="mono">{r.salesOrder.number}</td>
                  <td className="num">{formatMoney(r.grossCommission)}</td>
                  <td className="num">{formatMoney(r.totalNet)}</td>
                  <td>
                    <StatusBadge status={r.status} extra={COMMISSION_TONES} label={stageOf(r.status, r.stage)} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
