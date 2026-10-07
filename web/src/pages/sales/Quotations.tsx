import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { Link, Navigate, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api, openPdf, qs } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { addDays, dayKeyOf, parseDay } from '../../lib/day';
import { DataList, type Column } from '../../components/DataList';
import { ApprovalStepper, DocumentApproval } from '../../components/ApprovalStepper';
import { ActivityLog } from '../../components/ActivityLog';
import { SO_TONES, type SalesOrderRow } from './SalesOrders';
import { quotationTotals as quotationMath } from '../../lib/quotationMath';
import { Checkbox, Empty, ErrorBox, Loading, StatusBadge, formatDate, formatDateTime, formatMoney, useToast, type Tone } from '../../components/ui';
import { NumberInput } from '../../components/NumberInput';

export const OUTCOMES = [
  { value: 'OPEN', label: 'Open' },
  { value: 'SUBMITTED', label: 'Submitted' },
  { value: 'NEGOTIATION', label: 'Negotiation' },
  { value: 'WON', label: 'Won' },
  { value: 'LOST', label: 'Lost' },
];

/**
 * A quotation's outcome on the shared pill (rule 12). OPEN reads as "somebody
 * owes an answer" rather than the built-in neutral — what the old local
 * `outcomeTone` said — and the rest are the built-in lifecycle colours.
 */
export const QUOTATION_OUTCOME_TONES: Record<string, Tone> = { OPEN: 'warn' };

/** A superseded revision is history, not a failure — neutral, not red. */
const REVISION_TONES: Record<string, Tone> = { SUPERSEDED: '' };

/**
 * Where an outcome may go from here — the legal moves only, so the page never
 * offers a button the server will refuse. The server holds the same rules
 * (`assertOutcomeChange` in api/src/shared/pipeline.ts); WON additionally
 * needs an approved revision and LOST a reason, both handled below.
 */
export const NEXT_OUTCOMES: Record<string, string[]> = {
  OPEN: ['SUBMITTED', 'NEGOTIATION', 'LOST'],
  SUBMITTED: ['NEGOTIATION', 'WON', 'LOST'],
  NEGOTIATION: ['WON', 'LOST'],
  // Reopening is allowed until a project exists (see the WON block).
  WON: ['NEGOTIATION'],
  LOST: ['NEGOTIATION'],
};

interface QuotationRow {
  id: string;
  number: string;
  subject: string;
  outcome: string;
  probability: number;
  customer: { id: string; name: string };
  owner: { id: string; name: string };
  createdAt: string;
  legacyQuote: LegacyRef | null;
  latest: { revision: number; status: string; total: number; updatedAt: string } | null;
}

/** The SCORO quote a live quotation carries on, under the same number. */
interface LegacyRef {
  id: string;
  number: string;
  status: string;
}

export function Quotations() {
  const { can } = useAuth();
  const navigate = useNavigate();
  const [params] = useSearchParams();

  /*
    `?new=1&leadId=&costingId=&customerId=` is the old hand-off to the create
    dialog. The dialog is gone — a quotation is written on its own page — but
    a bookmark or an old link still lands somewhere sensible: the editor, with
    the same preset. Replace, so Back does not bounce through this redirect.
  */
  if (params.get('new') && can('gops.quotations.create')) {
    return (
      <Navigate
        replace
        to={`/g-ops/quotations/new${qs({
          leadId: params.get('leadId'),
          costingId: params.get('costingId'),
          customerId: params.get('customerId'),
        })}`}
      />
    );
  }

  const columns: Column<QuotationRow>[] = [
    {
      key: 'number',
      label: 'Number',
      sortKey: 'number',
      width: '160px',
      render: (q) => (
        <div>
          <span className="mono">{q.number}</span>
          {q.legacyQuote && <div className="faint">from SCORO</div>}
        </div>
      ),
    },
    {
      key: 'subject',
      label: 'Quotation',
      sortKey: 'subject',
      render: (q) => (
        <div>
          <div>{q.subject}</div>
          <div className="faint">{q.customer.name}</div>
        </div>
      ),
    },
    {
      key: 'revision',
      label: 'Revision',
      render: (q) =>
        q.latest ? (
          <span>
            R{q.latest.revision} <StatusBadge status={q.latest.status} extra={REVISION_TONES} />
          </span>
        ) : (
          <span className="faint">—</span>
        ),
    },
    {
      key: 'total',
      label: 'Total',
      align: 'right',
      render: (q) => (q.latest ? <span className="mono">{formatMoney(q.latest.total)}</span> : '—'),
    },
    { key: 'owner', label: 'Owner', render: (q) => q.owner.name },
    { key: 'createdAt', label: 'Raised', sortKey: 'createdAt', render: (q) => formatDate(q.createdAt) },
    {
      key: 'outcome',
      label: 'Outcome',
      render: (q) => <StatusBadge status={q.outcome} extra={QUOTATION_OUTCOME_TONES} />,
    },
  ];

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Quotations</h1>
          <p>
            Revisions are preserved, never overwritten — R0 stays readable after R1 changes the
            price. Only the author can edit a quotation, and only one revision can be approved.
          </p>
        </div>
      </div>

      <DataList<QuotationRow>
        listKey="quotations"
        endpoint="/quotations"
        columns={columns}
        rowKey={(q) => q.id}
        scoped
        searchPlaceholder="Search number, subject, customer…"
        onRowClick={(q) => navigate(`/g-ops/quotations/${q.id}`)}
        emptyTitle="No quotations yet"
        filters={[{ key: 'outcome', label: 'Outcome', options: OUTCOMES }]}
        actions={
          can('gops.quotations.create') ? (
            <Link className="btn btn-primary btn-sm" to="/g-ops/quotations/new">
              + New quotation
            </Link>
          ) : null
        }
      />
    </div>
  );
}

// ── Detail ───────────────────────────────────────────────────────────────────

export interface Person {
  id: string;
  name: string;
  position?: string | null;
}

export interface SupplierRef {
  id: string;
  code?: string;
  name: string;
}

/**
 * A SCORO-style line. The cost half (unitCost … marginPct) is present only
 * when the server decided this viewer may see cost — the keys are stripped
 * server-side otherwise, so the screen never has them to hide.
 */
export interface Item {
  id: string;
  group: string | null;
  /** A subheading: its title is the heading; no quantity, price or cost. */
  isHeading?: boolean;
  title: string | null;
  description: string;
  quantity: number;
  unit: string;
  unitPrice: number;
  amount: number;
  sortOrder: number;
  unitCost?: number | null;
  costAmount?: number | null;
  margin?: number | null;
  marginPct?: number | null;
  providerSupplierId?: string | null;
  providerSupplier?: SupplierRef | null;
  providerUserId?: string | null;
  providerUser?: Person | null;
  costNote?: string | null;
}

/** SCORO's right-hand panel. Percentages are of the sum without tax. */
export interface CostPanel {
  totalCost: number;
  inHouseCost: number;
  outsourcedCost: number;
  unassignedCost: number;
  totalMargin: number;
  inHouseMargin: number;
  outsourcedMargin: number;
  unassignedMargin: number;
  totalCostPct: number | null;
  inHouseCostPct: number | null;
  outsourcedCostPct: number | null;
  totalMarginPct: number | null;
  inHouseMarginPct: number | null;
  outsourcedMarginPct: number | null;
  costedLines: number;
  lineCount: number;
}

export interface Revision {
  id: string;
  revision: number;
  status: string;
  validityDays: number;
  terms: string | null;
  notes: string | null;
  /** Σ line amount, BEFORE the discount. */
  subtotal: number;
  discountPct: number;
  discountAmount: number;
  /** subtotal − discount. */
  net: number;
  /** SCORO's "Sum without tax" — net, less the tax when prices include it. */
  netOfTax?: number;
  vatAmount: number;
  total: number;
  vatRate: number;
  vatInclusive: boolean;
  /** SCORO's "Hide total": the PDF leaves the totals off. */
  hideTotal?: boolean;
  prNumber: string | null;
  delivery: string | null;
  paymentTerms: string | null;
  approvedAt: string | null;
  createdAt: string;
  items: Item[];
  costPanel?: CostPanel;
  /** totalCost is absent when this viewer may not see cost. */
  costing: { id: string; number: string; title: string; contractValue: number; totalCost?: number } | null;
  approvedBy: { id: string; name: string } | null;
  /** The project this revision became, if any (Job.quotationRevisionId). */
  jobs: { id: string; number: string; name: string; status: string }[];
}

/** One move of the outcome, off the audit trail (outcomeChanges in api/src/shared/pipeline.ts). */
export interface StatusChange {
  from: string;
  to: string;
  at: string;
  by: { id: string | null; name: string } | null;
}

/** Days spent in one outcome — SCORO's "Opportunity 46 days". */
export interface OutcomeStage {
  outcome: string;
  days: number;
  current: boolean;
}

export interface QuotationDetail {
  id: string;
  number: string;
  subject: string;
  outcome: string;
  probability: number;
  lostReason: string | null;
  submittedAt: string | null;
  decidedAt?: string | null;
  expectedClosing: string | null;
  createdAt?: string;
  canEdit: boolean;
  /** Whether the server sent the cost half of each line. */
  canSeeCost: boolean;
  customer: {
    id: string;
    name: string;
    code: string;
    paymentTerms: string | null;
    legalName?: string | null;
    /** The first active site's address — a customer keeps its addresses on its sites. */
    address?: string | null;
    phone?: string | null;
  };
  contact: {
    id: string;
    name: string;
    position?: string | null;
    email?: string | null;
    phone?: string | null;
    mobile?: string | null;
  } | null;
  site: { id: string; name: string; address?: string | null; city?: string | null } | null;
  lead: { id: string; number: string; companyName: string } | null;
  owner: { id: string; name: string };
  legacyQuote: LegacyRef | null;
  revisions: Revision[];
  /** Oldest first. */
  statusHistory?: StatusChange[];
  stages?: OutcomeStage[];
  /** Issue to decision, once the quotation is won or lost. */
  closedInDays?: number | null;
  /** The company's VAT rate. */
  companyVatRate?: number;
  /** What the Tax dropdown offers: the company rate, 8%, 6% (Government), 0%. */
  taxOptions?: { rate: number; label: string }[];
  /** Optional approval routes for the draft at its total — "Add the CEO as approver". */
  approvalOptions?: { id: string; label: string }[];
  /** Where "Submit for approval" goes from here — the standard route and each option's — and who decides each step. */
  approvalRoutes?: { standard: ApprovalRoute | null; options: { id: string; route: ApprovalRoute | null }[] } | null;
}

interface ApprovalRoute {
  name: string;
  steps: { name: string; approvers: { id: string; name: string }[] }[];
}

/**
 * The lines as the page shows them: a subheading is a wide heading row; every
 * other line is numbered, its group in its own column as SCORO lists it.
 */
export function displayRows(items: Item[]): ({ kind: 'heading'; key: string; text: string } | { kind: 'line'; item: Item; n: number })[] {
  const rows: ({ kind: 'heading'; key: string; text: string } | { kind: 'line'; item: Item; n: number })[] = [];
  let n = 0;
  for (const item of items) {
    if (item.isHeading) rows.push({ kind: 'heading', key: item.id, text: item.title ?? '' });
    else rows.push({ kind: 'line', item, n: ++n });
  }
  return rows;
}

const pct = (v: number | null | undefined) => (v == null ? '—' : `${v.toFixed(1)}%`);

export function QuotationDetail() {
  const { id } = useParams<{ id: string }>();
  const { can } = useAuth();
  const toast = useToast();

  const [quotation, setQuotation] = useState<QuotationDetail | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  /** "Lost" chosen: the reason is asked for here, in the page. */
  const [losing, setLosing] = useState(false);
  const [lostReason, setLostReason] = useState('');
  const [deleting, setDeleting] = useState(false);
  const [optionId, setOptionId] = useState<string | null>(null);
  const [bookingOrder, setBookingOrder] = useState(false);
  const [reload, setReload] = useState(0);
  const navigate = useNavigate();

  const load = useCallback(async () => {
    if (!id) return;
    try {
      const q = await api.get<QuotationDetail>(`/quotations/${id}`);
      setQuotation(q);
      setSelected((prev) => prev ?? q.revisions[0]?.id ?? null);
      setError(null);
      setReload((r) => r + 1);
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading) return <Loading />;
  if (!quotation) return <ErrorBox error={error ?? new Error('Quotation not found')} />;

  const revision = quotation.revisions.find((r) => r.id === selected) ?? quotation.revisions[0];
  // SCORO's panel beside the totals, once there is a line to cost.
  const showPanel = quotation.canSeeCost && !!revision?.costPanel && revision.items.length > 0;
  const editable = quotation.canEdit && revision?.status === 'DRAFT';
  const approved = quotation.revisions.find((r) => r.status === 'APPROVED') ?? null;
  const jobs = quotation.revisions.flatMap((r) => r.jobs ?? []);
  const showCost = quotation.canSeeCost;
  // Everything is changed on the full-page editor — a draft's lines and terms,
  // or, once no revision is a draft, the quotation's own details.
  const editHref = `/g-ops/quotations/${quotation.id}/edit`;
  const canDelete =
    quotation.canEdit &&
    can('gops.quotations.delete') &&
    quotation.outcome !== 'WON' &&
    jobs.length === 0 &&
    !quotation.revisions.some((r) => r.status === 'PENDING_APPROVAL');

  async function act(fn: () => Promise<unknown>, message: string) {
    try {
      await fn();
      toast('ok', message);
      await load();
    } catch (err) {
      setError(err);
    }
  }

  async function markLost() {
    try {
      await api.patch(`/quotations/${quotation!.id}`, { outcome: 'LOST', lostReason: lostReason.trim() });
      setLosing(false);
      setLostReason('');
      toast('ok', `${quotation!.number} marked lost`);
      await load();
    } catch (err) {
      setError(err);
    }
  }

  async function remove() {
    try {
      await api.del(`/quotations/${quotation!.id}`);
      toast('ok', `${quotation!.number} deleted`);
      navigate('/g-ops/quotations');
    } catch (err) {
      setError(err);
      setDeleting(false);
    }
  }

  function printPdf() {
    if (!revision) return;
    const option = optionId && (quotation!.approvalOptions ?? []).some((o) => o.id === optionId) ? optionId : null;
    openPdf(`/api/quotations/${quotation!.id}/revisions/${revision.id}/pdf${qs({ option })}`, () =>
      toast('error', 'Could not render the quotation'),
    );
  }

  // A quotation that became a project stays won — no moves at all.
  const moves = (quotation.outcome === 'WON' && jobs.length > 0 ? [] : (NEXT_OUTCOMES[quotation.outcome] ?? [])).map(
    (o) => ({ value: o, label: outcomeLabel(o) }),
  );
  const reopening = quotation.outcome === 'WON' || quotation.outcome === 'LOST';

  // SCORO's status block, off the audit trail: the last move says what the
  // status was before, and who moved it when.
  const history = quotation.statusHistory ?? [];
  const lastMove = history.length ? history[history.length - 1] : null;
  const lastTo = (outcome: string) => [...history].reverse().find((c) => c.to === outcome) ?? null;
  const won = quotation.outcome === 'WON' ? lastTo('WON') : null;
  const lost = quotation.outcome === 'LOST' ? lastTo('LOST') : null;
  const sent = lastTo('SUBMITTED');

  const issued = revision ? dayKeyOf(new Date(revision.createdAt)) : null;
  const due = revision && issued ? addDays(issued, revision.validityDays) : null;
  const canSubmit = editable && !!revision && revision.items.length > 0;
  const canSend = quotation.canEdit && moves.some((m) => m.value === 'SUBMITTED');
  const address = quotation.site?.address
    ? [quotation.site.address, quotation.site.city].filter(Boolean).join(', ')
    : quotation.customer.address;
  const contactLine = quotation.contact
    ? [quotation.contact.mobile || quotation.contact.phone, quotation.contact.email].filter(Boolean).join(' · ')
    : '';

  function changeOutcome(next: string) {
    if (!next) return;
    if (next === 'LOST') {
      setLostReason(quotation!.lostReason ?? '');
      setLosing(true);
      return;
    }
    void act(
      () => api.patch(`/quotations/${quotation!.id}`, { outcome: next }),
      reopening ? 'Reopened' : `Marked ${outcomeLabel(next).toLowerCase()}`,
    );
  }

  return (
    <div>
      <div className="breadcrumb">
        {quotation.lead && (
          <>
            <Link to={`/g-ops/leads/${quotation.lead.id}`}>{quotation.lead.number}</Link>
            <span className="sep">›</span>
          </>
        )}
        <Link to="/g-ops/quotations">Quotations</Link>
        <span className="sep">›</span>
        <span className="mono">
          {quotation.number}
          {revision ? ` R${revision.revision}` : ''}
        </span>
        {revision?.costing && (
          <>
            <span className="sep">›</span>
            <Link to={`/g-ops/costing/${revision.costing.id}`}>{revision.costing.number}</Link>
          </>
        )}
        {jobs.map((j) => (
          <span key={j.id}>
            <span className="sep">›</span>
            <Link to={`/g-ops/projects/${j.id}`}>{j.number}</Link>
          </span>
        ))}
      </div>

      {quotation.legacyQuote && (
        <div className="alert info">
          Continued from SCORO{' '}
          <Link to={`/g-ops/quote-archive/${quotation.legacyQuote.id}`} className="mono">
            {quotation.legacyQuote.number}
          </Link>{' '}
          ({quotation.legacyQuote.status}). The SCORO record stays in the archive, read-only; this is
          the live quotation from here on.
        </div>
      )}

      <ErrorBox error={error} />

      {/*
        SCORO's "Quote details": the same labels in the same two columns, so a
        salesperson coming from SCORO finds each thing where they left it.
      */}
      <section className="card qd-card" aria-labelledby="qd-title">
        <div className="qd-head">
          <h1 id="qd-title" className="qd-title">
            Quote details
          </h1>
          <div className="row qd-actions">
            {can('gops.quotations.create') && revision && (
              <Link
                className="btn"
                to={`/g-ops/quotations/new${qs({ duplicate: quotation.id, revision: revision.id })}`}
                title="A new quotation with this one's client, terms and lines — numbered when you save it"
              >
                Duplicate
              </Link>
            )}
            {quotation.canEdit && revision?.status !== 'DRAFT' && (
              <button
                className="btn"
                onClick={() => {
                  // The server withdraws a pending revision's approval request
                  // as it supersedes it; say so, since the approver is told.
                  const pending = quotation.revisions[0]?.status === 'PENDING_APPROVAL' ? quotation.revisions[0] : null;
                  return act(
                    () => api.post(`/quotations/${quotation.id}/revisions`),
                    pending ? `New revision raised — R${pending.revision} is withdrawn from approval` : 'New revision raised',
                  );
                }}
              >
                New revision
              </button>
            )}
            {quotation.canEdit && (
              <Link className="btn btn-primary" to={editHref}>
                Modify
              </Link>
            )}
            {canDelete &&
              (deleting ? (
                <span className="row qd-confirm" role="group" aria-label="Confirm delete">
                  <span className="qd-confirm-text">Delete {quotation.number}?</span>
                  <button className="btn btn-danger" onClick={() => void remove()}>
                    Delete
                  </button>
                  <button className="btn" onClick={() => setDeleting(false)}>
                    Keep it
                  </button>
                </span>
              ) : (
                <button className="btn btn-danger" onClick={() => setDeleting(true)}>
                  Delete
                </button>
              ))}
          </div>
        </div>

        <div className="qd-grid">
          <div className="qd-col">
            <dl className="qd-group">
              <Detail label="Quote No.">
                <span className="mono">{quotation.number}</span>
              </Detail>
              {quotation.revisions.length > 0 && (
                <Detail label="Revision">
                  {/* Every revision, newest first. Choosing one shows what was sent then. */}
                  <div className="row qd-revisions">
                    {quotation.revisions.map((r) => (
                      <button
                        key={r.id}
                        className={`btn btn-sm qd-revision${r.id === revision?.id ? ' btn-primary is-selected' : ''}`}
                        onClick={() => setSelected(r.id)}
                        aria-pressed={r.id === revision?.id}
                      >
                        R{r.revision} <StatusBadge status={r.status} extra={REVISION_TONES} />
                      </button>
                    ))}
                  </div>
                </Detail>
              )}
              <Detail label="Date of issue">{revision ? formatDate(revision.createdAt) : null}</Detail>
              <Detail label="Quote name">{quotation.subject}</Detail>
            </dl>

            <dl className="qd-group">
              <Detail label="Client">
                <Link className="qd-strong" to={`/g-ops/customers/${quotation.customer.id}`}>
                  {quotation.customer.legalName || quotation.customer.name}
                </Link>
                {address && <div className="qd-sub">{address}</div>}
                {quotation.customer.phone && <div className="qd-sub">{quotation.customer.phone}</div>}
              </Detail>
              <Detail label="Contact person">
                {quotation.contact && (
                  <>
                    <span className="qd-strong">{quotation.contact.name}</span>
                    {quotation.contact.position && <span className="qd-sub"> · {quotation.contact.position}</span>}
                    {contactLine && <div className="qd-sub">{contactLine}</div>}
                  </>
                )}
              </Detail>
              {quotation.site && <Detail label="Site">{quotation.site.name}</Detail>}
            </dl>

            <dl className="qd-group">
              <Detail label="Project">
                <ProjectCell approved={approved} jobs={jobs} outcome={quotation.outcome} can={can} />
              </Detail>
              {quotation.lead && (
                <Detail label="Enquiry">
                  <Link to={`/g-ops/leads/${quotation.lead.id}`}>
                    {quotation.lead.number} — {quotation.lead.companyName}
                  </Link>
                </Detail>
              )}
              {revision?.costing && (
                <Detail label="Costing">
                  <Link to={`/g-ops/costing/${revision.costing.id}`}>
                    {revision.costing.number} — {revision.costing.title}
                  </Link>
                </Detail>
              )}
            </dl>

            <dl className="qd-group">
              <Detail label="Comment">{revision?.notes ? <span className="qd-pre">{revision.notes}</span> : null}</Detail>
              {revision?.terms && (
                <Detail label="Terms">
                  <span className="qd-pre">{revision.terms}</span>
                </Detail>
              )}
            </dl>
          </div>

          <div className="qd-col">
            <dl className="qd-group">
              <Detail label="Author">{quotation.owner.name}</Detail>
              <Detail label="Due date">
                {due && revision ? (
                  <>
                    {formatDate(parseDay(due))}{' '}
                    <span className="qd-sub">
                      ({revision.validityDays} day{revision.validityDays === 1 ? '' : 's'})
                    </span>
                  </>
                ) : null}
              </Detail>
              <Detail label="Estimated closing date">{quotation.expectedClosing ? formatDate(quotation.expectedClosing) : null}</Detail>
            </dl>

            <dl className="qd-group">
              <Detail label="Previous status">
                {lastMove ? <StatusBadge status={lastMove.from} extra={QUOTATION_OUTCOME_TONES} /> : null}
              </Detail>
              <Detail label="Status">
                <span className="qd-status">
                  <StatusBadge status={quotation.outcome} extra={QUOTATION_OUTCOME_TONES} />
                  <Stamp at={lastMove?.at ?? quotation.createdAt} by={lastMove?.by} />
                </span>
                {/* SCORO's days-in-status, as one quiet line rather than a row of tiles. */}
                {((quotation.stages?.length ?? 0) > 0 || quotation.closedInDays != null) && (
                  <div className="qd-sub qd-days">
                    {(quotation.stages ?? [])
                      .map((st) => `${outcomeLabel(st.outcome)} ${dayCount(st.days)}${st.current ? ' so far' : ''}`)
                      .join(' · ')}
                    {quotation.closedInDays != null ? ` · ${quotation.outcome === 'WON' ? 'won' : 'lost'} in ${dayCount(quotation.closedInDays)}` : ''}
                  </div>
                )}
                {quotation.canEdit && moves.length > 0 && (
                  <div className="qd-status-change">
                    <select
                      aria-label="Change status"
                      aria-describedby="qd-status-hint"
                      value=""
                      onChange={(e) => changeOutcome(e.target.value)}
                    >
                      <option value="">Change status…</option>
                      {moves.map((o) => {
                        const needsApproval = o.value === 'WON' && !approved;
                        return (
                          <option key={o.value} value={o.value} disabled={needsApproval}>
                            {reopening ? `Reopen — ${o.label}` : o.label}
                            {o.value === 'LOST' ? '…' : ''}
                            {needsApproval ? ' (needs an approved revision)' : ''}
                          </option>
                        );
                      })}
                    </select>
                    <p id="qd-status-hint" className="faint sales-hint">
                      Moving it here also moves its lead, so the pipeline stays honest.
                      {quotation.outcome !== 'WON' && !approved
                        ? ' Won is available once a revision is approved — only the approved revision becomes a project.'
                        : ''}
                    </p>
                  </div>
                )}
                {losing && (
                  <div className="qd-lost">
                    <label htmlFor="qd-lost-reason" className="qd-lost-label">
                      Why was it lost?
                    </label>
                    <textarea
                      id="qd-lost-reason"
                      rows={2}
                      autoFocus
                      value={lostReason}
                      onChange={(e) => setLostReason(e.target.value)}
                    />
                    <div className="row qd-lost-actions">
                      <button className="btn btn-danger btn-sm" disabled={!lostReason.trim()} onClick={() => void markLost()}>
                        Mark lost
                      </button>
                      <button className="btn btn-sm" onClick={() => setLosing(false)}>
                        Cancel
                      </button>
                      <span className="faint sales-hint">Sales Analytics reports the reasons.</span>
                    </div>
                  </div>
                )}
              </Detail>
              {quotation.outcome === 'WON' && (
                <Detail label="Date confirmed">
                  <Stamp at={won?.at ?? quotation.decidedAt} by={won?.by} />
                </Detail>
              )}
              {quotation.outcome === 'LOST' && (
                <>
                  <Detail label="Date lost">
                    <Stamp at={lost?.at ?? quotation.decidedAt} by={lost?.by} />
                  </Detail>
                  <Detail label="Lost because">{quotation.lostReason}</Detail>
                </>
              )}
              <Detail label="Sent">
                {quotation.submittedAt || sent ? (
                  <span className="qd-status">
                    Yes <Stamp at={sent?.at ?? quotation.submittedAt} by={sent?.by} />
                  </span>
                ) : (
                  'No'
                )}
              </Detail>
            </dl>

            {revision && (
              <dl className="qd-group">
                <Detail label="PR Number">{revision.prNumber}</Detail>
                <Detail label="Payment Terms">{revision.paymentTerms}</Detail>
                <Detail label="Delivery">{revision.delivery}</Detail>
                <Detail label="VAT">
                  {revision.vatRate === 0
                    ? '0% — zero-rated'
                    : `${Number((revision.vatRate * 100).toFixed(2))}% — ${revision.vatInclusive ? 'included in the prices' : 'added on top of the prices'}`}
                </Detail>
                {revision.hideTotal && <Detail label="Hide total">Yes — the PDF prints the lines without the totals</Detail>}
              </dl>
            )}
          </div>
        </div>

        {/* SCORO's action bar, at the foot of the details it acts on. */}
        <div className="qd-bar">
          <div className="row">
            <ProjectActions quotation={quotation} jobs={jobs} can={can} />
          </div>
          <div className="row">
            <button className="btn" onClick={printPdf} disabled={!revision}>
              PDF
            </button>
            {can('gops.sales_orders.create') && (
              <button
                className="btn"
                aria-expanded={bookingOrder}
                aria-controls="qd-create-so"
                onClick={() => setBookingOrder((v) => !v)}
                disabled={!quotation.revisions.some((r) => r.items.some((i) => !i.isHeading))}
                title="Book this quotation in operations — SCORO's Create invoice"
              >
                Create Sales Order
              </button>
            )}
            {canSubmit &&
              (quotation.approvalOptions ?? []).map((o) => (
                <Checkbox
                  key={o.id}
                  checked={optionId === o.id}
                  onChange={(v) => setOptionId(v ? o.id : null)}
                  label={o.label}
                />
              ))}
            {canSubmit && (
              <button
                className="btn btn-ok"
                onClick={() =>
                  act(
                    () =>
                      api.post(`/quotations/${quotation.id}/revisions/${revision!.id}/submit`, {
                        optionId: optionId && (quotation.approvalOptions ?? []).some((o) => o.id === optionId) ? optionId : null,
                      }),
                    'Submitted for approval',
                  )
                }
              >
                Submit for approval
              </button>
            )}
            {canSend && (
              <button
                className="btn btn-primary"
                title="Records that the customer has it. Email the PDF as you always have."
                onClick={() =>
                  act(() => api.patch(`/quotations/${quotation.id}`, { outcome: 'SUBMITTED' }), 'Marked as sent')
                }
              >
                Mark as sent
              </button>
            )}
          </div>
        </div>
        {canSubmit &&
          (() => {
            // The route the submit would take — the option's when it is
            // ticked — with who decides each step, named before anybody
            // presses Submit. The submitter is never among them.
            const chosen = optionId ? quotation.approvalRoutes?.options.find((o) => o.id === optionId)?.route : null;
            const route = chosen ?? quotation.approvalRoutes?.standard;
            if (!route?.steps.length) return null;
            return (
              <div className="qd-route">
                <span className="qd-route-label">Submit for approval sends it to</span>
                <ApprovalStepper
                  steps={route.steps.map((st) => ({
                    label: st.name,
                    approver: st.approvers.length
                      ? st.approvers.map((p) => p.name).join(' or ')
                      : 'Nobody — no one else holds this role',
                    status: 'WAITING',
                  }))}
                />
              </div>
            );
          })()}
        {bookingOrder && (
          <CreateSalesOrderPanel
            quotation={quotation}
            onClose={() => setBookingOrder(false)}
          />
        )}
      </section>

      {revision && (
        <>
          {revision.status === 'PENDING_APPROVAL' && (
            <div className="alert info">
              Revision {revision.revision} is with the approver. It cannot be edited until they
              decide — raise a new revision if something must change, and this one is withdrawn
              from their queue.
            </div>
          )}
          {revision.status === 'APPROVED' && (
            <div className="alert ok">
              Approved{revision.approvedBy ? ` by ${revision.approvedBy.name}` : ''}
              {revision.approvedAt ? ` on ${formatDateTime(revision.approvedAt)}` : ''}. This is the
              revision a project will be created from.
            </div>
          )}
          {revision.status === 'SUPERSEDED' && (
            <div className="alert info">
              Superseded by a later revision. Kept because it is what the customer was sent.
            </div>
          )}

          {/* Who has this revision, and since when — the one approval rail. */}
          <DocumentApproval documentType="quotation" documentId={revision.id} reloadToken={reload} />

          <div className="card sales-card-gap">
            <div className="row sales-card-head">
              <h2 className="card-title">Lines</h2>
              {editable && (
                <div className="row">
                  {revision.costing && (
                    <button
                      className="btn btn-sm"
                      onClick={() =>
                        act(
                          () =>
                            api.post(
                              `/quotations/${quotation.id}/revisions/${revision.id}/from-costing`,
                            ),
                          'Filled from the costing scope of work',
                        )
                      }
                    >
                      Fill from costing
                    </button>
                  )}
                  <Link className="btn btn-primary btn-sm" to={editHref}>
                    Edit lines
                  </Link>
                </div>
              )}
            </div>

            {revision.items.length === 0 ? (
              <Empty
                title="No lines yet"
                hint={
                  revision.costing
                    ? 'Use “Fill from costing” to bring in the scope sections you already priced, or type the lines in under Edit lines.'
                    : 'Type the lines in under Edit lines, or link a costing there and fill them from its scope of work.'
                }
              />
            ) : (
              <div className="table-wrap">
                <table className="data quote-lines">
                  <thead>
                    <tr>
                      <th className="sales-col-num">#</th>
                      <th>Group</th>
                      <th className="qd-col-product">Product | Description</th>
                      <th className="right">Qty | Unit</th>
                      <th className="right">Unit price</th>
                      <th className="right">Amount</th>
                      {showCost && <th>Cost &amp; provider</th>}
                      {showCost && <th className="right">Margin</th>}
                      {editable && <th className="sales-col-action" />}
                    </tr>
                  </thead>
                  <tbody>
                    {displayRows(revision.items).map((row) =>
                      row.kind === 'heading' ? (
                        <tr key={row.key} className="quote-heading-row">
                          <td />
                          <td colSpan={5 + (showCost ? 2 : 0) + (editable ? 1 : 0)}>{row.text}</td>
                        </tr>
                      ) : (
                      <tr key={row.item.id}>
                        <td className="mono">{row.n}</td>
                        <td>{row.item.group || <span className="faint">—</span>}</td>
                        <td>
                          {row.item.title && <div className="quote-line-title">{row.item.title}</div>}
                          {row.item.description && <div className="quote-line-desc">{row.item.description}</div>}
                        </td>
                        <td className="right mono">
                          {row.item.quantity} <span className="faint">{row.item.unit}</span>
                        </td>
                        <td className="right mono">{formatMoney(row.item.unitPrice)}</td>
                        <td className="right mono">{formatMoney(row.item.amount)}</td>
                        {showCost && (
                          <td>
                            <LineCost item={row.item} />
                          </td>
                        )}
                        {showCost && (
                          <td className="right mono">
                            {row.item.margin == null ? (
                              <span className="faint">—</span>
                            ) : (
                              <>
                                <div className={row.item.margin < 0 ? 'quote-negative' : undefined}>{formatMoney(row.item.margin)}</div>
                                <div className="faint">{pct(row.item.marginPct)}</div>
                              </>
                            )}
                          </td>
                        )}
                        {editable && (
                          <td>
                            <Link
                              className="btn btn-sm"
                              to={`${editHref}#line-${row.n}`}
                              aria-label={`Modify line ${row.n}`}
                            >
                              Modify
                            </Link>
                          </td>
                        )}
                      </tr>
                      ),
                    )}
                  </tbody>
                </table>
              </div>
            )}

            <div className={`quote-summary${showPanel ? '' : ' quote-summary-single'}`}>
              <TotalsBlock
                quotationId={quotation.id}
                revision={revision}
                editable={editable}
                onSaved={() => void load()}
                onError={setError}
              />
              {showPanel && revision.costPanel && <CostPanelBlock panel={revision.costPanel} />}
            </div>
          </div>

          {(can('gops.sales_orders.view_all') || can('gops.sales_orders.view_own')) && (
            <QuotationSalesOrders
              quotationId={quotation.id}
              quotationTotal={Number(
                (quotation.revisions.find((r) => r.status === 'APPROVED') ??
                  quotation.revisions.reduce<QuotationDetail['revisions'][number] | null>(
                    (best, r) => (best === null || r.revision > best.revision ? r : best),
                    null,
                  ))?.total ?? 0,
              )}
              reloadToken={reload}
              onBook={() => setBookingOrder(true)}
            />
          )}

          <div className="sales-card-gap">
            <ActivityLog quotationId={quotation.id} canEdit={quotation.canEdit} />
          </div>
        </>
      )}

    </div>
  );
}

/**
 * The sales orders booked from this quotation, listed under it the way SCORO
 * lists a quote's invoices (2026-10-07, the owner's call). The list is the
 * ordinary `/sales-orders?quotationId=` query, so it shows exactly what the
 * reader may open there — a `view_own` holder sees only their own.
 */
function QuotationSalesOrders({
  quotationId,
  quotationTotal,
  reloadToken,
  onBook,
}: {
  quotationId: string;
  quotationTotal: number;
  reloadToken: number;
  onBook: () => void;
}) {
  const { can } = useAuth();
  const [rows, setRows] = useState<SalesOrderRow[] | null>(null);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    let alive = true;
    api
      .get<{ rows: SalesOrderRow[] }>(`/sales-orders${qs({ quotationId, pageSize: 100, sort: 'number', dir: 'asc' })}`)
      .then((r) => alive && setRows(r.rows))
      .catch((err) => alive && setError(err));
    return () => {
      alive = false;
    };
  }, [quotationId, reloadToken]);

  // Booked is what live orders carry; a cancelled order books nothing.
  const booked = Math.round((rows ?? []).filter((r) => r.status !== 'CANCELLED').reduce((n, r) => n + r.total, 0) * 100) / 100;
  const outstanding = Math.max(0, Math.round((quotationTotal - booked) * 100) / 100);

  return (
    <div className="card sales-card-gap">
      <div className="row sales-card-head">
        <h2 className="card-title">Sales orders</h2>
        {rows && rows.length > 0 && can('gops.sales_orders.create') && outstanding > 0 && (
          <button type="button" className="btn btn-sm" onClick={onBook}>
            Create Sales Order
          </button>
        )}
      </div>
      {rows && rows.length > 0 && (
        <div className="so-sum" aria-label="Booking against the quotation">
          <dl>
            <dt>Quotation total</dt>
            <dd className="mono">{formatMoney(quotationTotal)}</dd>
          </dl>
          <dl>
            <dt>Booked ({rows.filter((r) => r.status !== 'CANCELLED').length} order{rows.filter((r) => r.status !== 'CANCELLED').length === 1 ? '' : 's'})</dt>
            <dd className="mono">{formatMoney(booked)}</dd>
          </dl>
          <dl>
            <dt>Outstanding</dt>
            <dd className="mono">{formatMoney(outstanding)}</dd>
          </dl>
        </div>
      )}
      <ErrorBox error={error} />
      {rows === null && !error ? (
        <Loading />
      ) : !rows?.length ? (
        <Empty
          title="No sales order yet"
          hint="Nothing has been booked from this quotation."
          action={
            can('gops.sales_orders.create') ? (
              <button type="button" className="btn btn-sm" onClick={onBook}>
                Create Sales Order
              </button>
            ) : undefined
          }
        />
      ) : (
        <div className="table-wrap">
          <table className="table so-table">
            <thead>
              <tr>
                <th>Number</th>
                <th>Date</th>
                <th>Status</th>
                <th>Customer PO</th>
                <th>SI / BS No.</th>
                <th>DR No.</th>
                <th className="num">Total</th>
                <th>Prepared by</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td>
                    <Link className="mono" to={`/g-ops/sales-orders/${r.id}`}>
                      {r.number}
                    </Link>
                  </td>
                  <td>{formatDate(r.orderDate)}</td>
                  <td>
                    <StatusBadge status={r.status} extra={SO_TONES} />
                  </td>
                  <td>{r.poNumber ?? <span className="faint">—</span>}</td>
                  <td>{r.siNumber ?? <span className="faint">—</span>}</td>
                  <td>{r.drNumber ?? <span className="faint">—</span>}</td>
                  <td className="num mono">{formatMoney(r.total)}</td>
                  <td>{r.owner.name}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/** Who carries a line's cost, and what it is — the cost column's cell. */
function LineCost({ item }: { item: Item }) {
  const who = item.providerUser
    ? { kind: 'In-house', name: item.providerUser.name }
    : item.providerSupplier
      ? { kind: 'Supplier', name: item.providerSupplier.name }
      : null;
  if (item.costAmount == null && !who) return <span className="faint">not costed</span>;
  return (
    <div className="quote-line-cost">
      <div className="mono">{item.costAmount == null ? '—' : formatMoney(item.costAmount)}</div>
      {who ? (
        <div className="faint">
          {who.kind} · {who.name}
        </div>
      ) : (
        <div className="faint">no provider named</div>
      )}
      {item.costNote && <div className="faint quote-line-desc">{item.costNote}</div>}
    </div>
  );
}

/**
 * SCORO's totals: subtotal, the discount (edited in place on a draft), the sum
 * without tax, the tax and the total. The figures are the server's — it
 * recomputes them on every save with the one `quotationTotals`.
 */
function TotalsBlock({
  quotationId,
  revision,
  editable,
  onSaved,
  onError,
}: {
  quotationId: string;
  revision: Revision;
  editable: boolean;
  onSaved: () => void;
  onError: (err: unknown) => void;
}) {
  const [discount, setDiscount] = useState(String(revision.discountPct ?? 0));
  const [busy, setBusy] = useState(false);

  useEffect(() => setDiscount(String(revision.discountPct ?? 0)), [revision.id, revision.discountPct]);

  async function commit() {
    if (busy) return;
    const value = Number(discount);
    if (!Number.isFinite(value) || value === revision.discountPct) {
      setDiscount(String(revision.discountPct ?? 0));
      return;
    }
    setBusy(true);
    try {
      await api.patch(`/quotations/${quotationId}/revisions/${revision.id}`, { discountPct: value });
      onSaved();
    } catch (err) {
      onError(err);
      setDiscount(String(revision.discountPct ?? 0));
    } finally {
      setBusy(false);
    }
  }

  const rate = `${(revision.vatRate * 100).toFixed(0)}%`;
  return (
    <div>
    <dl className="quote-totals" aria-label="Totals">
      <div>
        <dt>Subtotal</dt>
        <dd className="mono">{formatMoney(revision.subtotal)}</dd>
      </div>
      <div>
        <dt>
          {editable ? (
            <label className="quote-discount">
              Discount
              <NumberInput
                kind="percent"
                min={0}
                max={100}
                step="0.01"
                value={discount}
                disabled={busy}
                aria-label="Discount percent"
                aria-describedby="quote-discount-hint"
                onChange={(e) => setDiscount(e.target.value)}
                onBlur={() => void commit()}
                onKeyDown={(e) => {
                  // Enter leaves the field, and leaving it is what saves — one
                  // PATCH, not one for the key and another for the blur.
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    e.currentTarget.blur();
                  }
                  if (e.key === 'Escape') setDiscount(String(revision.discountPct ?? 0));
                }}
              />
              %
            </label>
          ) : (
            `Discount ${revision.discountPct ? `${revision.discountPct}%` : ''}`
          )}
        </dt>
        <dd className="mono">{revision.discountAmount > 0 ? `−${formatMoney(revision.discountAmount)}` : formatMoney(0)}</dd>
      </div>
      <div>
        <dt>Sum without tax</dt>
        <dd className="mono">{formatMoney(revision.netOfTax ?? revision.net)}</dd>
      </div>
      <div>
        <dt>{revision.vatInclusive ? `Tax included (${rate})` : `Tax (${rate})`}</dt>
        <dd className="mono">{formatMoney(revision.vatAmount)}</dd>
      </div>
      <div className="quote-totals-grand">
        <dt>Total</dt>
        <dd className="mono">{formatMoney(revision.total)}</dd>
      </div>
    </dl>
      {editable && (
        <p id="quote-discount-hint" className="faint sales-hint">
          The discount comes off the whole quotation before tax. Enter to save.
        </p>
      )}
    </div>
  );
}

/** SCORO's right-hand panel: cost and margin, in-house against outsourced. */
export function CostPanelBlock({ panel }: { panel: CostPanel }) {
  const row = (label: string, value: number, share: number | null, strong = false) => (
    <div className={strong ? 'quote-totals-grand' : undefined}>
      <dt>{label}</dt>
      <dd className="mono">
        <span className={value < 0 ? 'quote-negative' : undefined}>{formatMoney(value)}</span>{' '}
        <span className="faint">{pct(share)}</span>
      </dd>
    </div>
  );
  return (
    <div className="quote-cost-panel">
      <h4 className="quote-panel-title">Cost and margin</h4>
      <dl className="quote-totals">
        {row('Total cost', panel.totalCost, panel.totalCostPct)}
        {row('In-house cost', panel.inHouseCost, panel.inHouseCostPct)}
        {row('Outsourced cost', panel.outsourcedCost, panel.outsourcedCostPct)}
        {panel.unassignedCost > 0 && row('No provider named', panel.unassignedCost, null)}
        {row('Total margin', panel.totalMargin, panel.totalMarginPct, true)}
        {row('In-house margin', panel.inHouseMargin, panel.inHouseMarginPct)}
        {row('Outsourced margin', panel.outsourcedMargin, panel.outsourcedMarginPct)}
      </dl>
      <p className="faint sales-hint">
        {panel.costedLines} of {panel.lineCount} line{panel.lineCount === 1 ? '' : 's'} costed. Percentages
        are of the sum without tax. Internal — never printed.
      </p>
    </div>
  );
}

type JobRef = { id: string; number: string; name: string; status: string };

/**
 * SCORO's Project row. A quotation that became a project links to it; a won
 * one not yet delivered offers "Create project" from the approved revision's
 * costing; before that the row says when a project becomes possible — so a won
 * quotation waiting on somebody reads differently from one already delivered.
 */
function ProjectCell({
  approved,
  jobs,
  outcome,
  can,
}: {
  approved: Revision | null;
  jobs: JobRef[];
  outcome: string;
  can: (permission: string) => boolean;
}) {
  if (jobs.length > 0) {
    return (
      <>
        {jobs.map((j, i) => (
          <span key={j.id}>
            {i > 0 && ', '}
            <Link to={`/g-ops/projects/${j.id}`} className="mono">
              {j.number}
            </Link>{' '}
            {j.name} <StatusBadge status={j.status} />
          </span>
        ))}
        <div className="qd-sub">It stays won while the project exists.</div>
      </>
    );
  }
  if (outcome !== 'WON') return <span className="faint">Created once the quotation is won</span>;
  if (!approved) return <span className="faint">No revision is approved, so there is nothing to build a project from yet</span>;
  if (!can('gops.projects.create')) return <span className="faint">Won — waiting for a project to be created</span>;
  return (
    <>
      <Link
        className="btn btn-sm btn-primary"
        to={`/g-ops/projects${qs({ new: 1, costingId: approved.costing?.id, quotationRevisionId: approved.id })}`}
      >
        Create project ›
      </Link>
      <div className="qd-sub">
        R{approved.revision} is the approved revision — its costing carries the budget and the schedule of values
        into the project.
      </div>
    </>
  );
}

/** The action bar's left end: a won quotation not yet delivered can also become a job order. */
function ProjectActions({
  quotation,
  jobs,
  can,
}: {
  quotation: QuotationDetail;
  jobs: JobRef[];
  can: (permission: string) => boolean;
}) {
  if (quotation.outcome !== 'WON' || jobs.length > 0 || !can('gops.job_orders.create')) return null;
  return (
    <Link
      className="btn"
      to={`/g-ops/job-orders${qs({
        new: 1,
        customerId: quotation.customer.id,
        siteId: quotation.site?.id,
        quotationId: quotation.id,
      })}`}
    >
      Request job order
    </Link>
  );
}

/** A SCORO label / value line: "Quote No.:  0012609061". An empty value reads as a dash. */
function Detail({ label, children }: { label: string; children?: ReactNode }) {
  const empty = children === null || children === undefined || children === '' || children === false;
  return (
    <div className="qd-row">
      <dt>{label}:</dt>
      <dd>{empty ? <span className="faint">—</span> : children}</dd>
    </div>
  );
}

/** "Sep 28, 2026, 02:28 PM | RA" — when a status was set, and by whom, as SCORO shows it. */
function Stamp({ at, by }: { at: string | null | undefined; by?: { name: string } | null }) {
  if (!at) return null;
  return (
    <span className="qd-stamp">
      {formatDateTime(at)}
      {by && (
        <>
          {' '}
          <span aria-hidden="true">|</span>{' '}
          <span title={by.name} aria-hidden="true">
            {initials(by.name)}
          </span>
          <span className="visually-hidden">by {by.name}</span>
        </>
      )}
    </span>
  );
}

const outcomeLabel = (o: string) => OUTCOMES.find((x) => x.value === o)?.label ?? o;
const dayCount = (n: number) => `${n} day${n === 1 ? '' : 's'}`;
const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w[0])
    .slice(0, 3)
    .join('')
    .toUpperCase();



interface BookingLineRow {
  id: string;
  group: string | null;
  title: string | null;
  description: string;
  isHeading: boolean;
  quantity: number;
  unit: string;
  unitPrice: number;
  amount: number;
  booked: number;
  available: number;
}

interface BookingData {
  quotationId: string;
  number: string;
  subject: string;
  revisionId: string;
  revision: number;
  revisionStatus: string;
  discountPct: number;
  vatRate: number;
  vatInclusive: boolean;
  net: number;
  total: number;
  bookedNet: number;
  availableNet: number;
  lines: BookingLineRow[];
}

type BookPick = { on: boolean; qty: number };

const round3 = (n: number) => Math.round(n * 1000) / 1000;
const round2 = (n: number) => Math.round(n * 100) / 100;
const round1 = (n: number) => Math.round(n * 10) / 10;

/**
 * SCORO's "Create invoice", in the page (no dialog): every line of the
 * quotation's VALUE revision with what is left of it, ticked and booked at a
 * percentage, a quantity or an amount; "100% of available" and "x% of quote
 * total" under the table; a target value (a percentage or a sum) that
 * scales the whole selection; and the selection's own subtotal, discount,
 * tax and total. What is left is the server's figure (`/sales-orders/
 * booking`) — the create route refuses more than is left, so two bookings
 * of the same line cannot both pass.
 */
function CreateSalesOrderPanel({ quotation, onClose }: { quotation: QuotationDetail; onClose: () => void }) {
  const navigate = useNavigate();
  const toast = useToast();
  const [booking, setBooking] = useState<BookingData | null>(null);
  const [picks, setPicks] = useState<Record<string, BookPick>>({});
  const [summarise, setSummarise] = useState(false);
  const [targetPct, setTargetPct] = useState('');
  const [targetSum, setTargetSum] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    let alive = true;
    api
      .get<BookingData>(`/sales-orders/booking${qs({ quotationId: quotation.id })}`)
      .then((b) => {
        if (!alive) return;
        setBooking(b);
        // SCORO opens with everything that is left ticked, in full.
        setPicks(Object.fromEntries(b.lines.filter((l) => !l.isHeading).map((l) => [l.id, { on: l.available > 0, qty: l.available }])));
      })
      .catch((err) => alive && setError(err));
    return () => {
      alive = false;
    };
  }, [quotation.id]);

  if (!booking) {
    return (
      <div id="qd-create-so" className="qd-route so-create" role="group" aria-label="Create Sales Order">
        <ErrorBox error={error} />
        {!error && <Loading />}
        {!!error && (
          <button className="btn btn-sm" onClick={onClose}>
            Close
          </button>
        )}
      </div>
    );
  }

  const lines = booking.lines.filter((l) => !l.isHeading);
  const amountOf = (l: BookingLineRow, qty: number) => round2(qty * l.unitPrice);
  const pctOf = (l: BookingLineRow, qty: number) => (l.available > 0 ? round1((qty / l.available) * 100) : 0);
  const selected = lines.filter((l) => picks[l.id]?.on && picks[l.id].qty > 0);
  const selection = quotationMath({
    lines: selected.map((l) => ({ amount: amountOf(l, picks[l.id].qty), isHeading: false })),
    discountPct: booking.discountPct,
    vatRate: booking.vatRate,
    vatInclusive: booking.vatInclusive,
  });
  const availableGrossOfSelected = selected.reduce((n, l) => n + amountOf(l, l.available), 0);
  const pctOfAvailable = booking.availableNet > 0 ? round1((selection.net / booking.availableNet) * 100) : 0;
  const pctOfQuote = booking.net > 0 ? round1((selection.net / booking.net) * 100) : 0;
  const nothingLeft = booking.availableNet <= 0 && lines.every((l) => l.available <= 0);

  const setQty = (l: BookingLineRow, qty: number) =>
    setPicks((p) => ({ ...p, [l.id]: { on: true, qty: round3(Math.min(l.available, Math.max(0, qty))) } }));
  const setOn = (l: BookingLineRow, on: boolean) =>
    setPicks((p) => ({ ...p, [l.id]: { on, qty: on && !(p[l.id]?.qty > 0) ? l.available : (p[l.id]?.qty ?? 0) } }));
  const applyTargetPct = (pct: number) => {
    const share = Math.min(100, Math.max(0, pct)) / 100;
    setPicks((p) => {
      const next = { ...p };
      for (const l of lines) if (next[l.id]?.on) next[l.id] = { on: true, qty: round3(l.available * share) };
      return next;
    });
  };

  // The groups, in the order the lines come — SCORO's EQUIPMENT row with a
  // tick that takes its whole section.
  const groups: { name: string; lines: BookingLineRow[] }[] = [];
  for (const l of lines) {
    const name = (l.group ?? '').trim() || 'Ungrouped';
    const g = groups.find((x) => x.name === name);
    if (g) g.lines.push(l);
    else groups.push({ name, lines: [l] });
  }
  const allOn = lines.filter((l) => l.available > 0).every((l) => picks[l.id]?.on);

  async function proceed() {
    if (!booking) return;
    setBusy(true);
    setError(null);
    try {
      const made = await api.post<{ id: string; number: string }>('/sales-orders', {
        quotationId: quotation.id,
        mode: summarise ? 'summary' : 'lines',
        lines: selected.map((l) => ({ id: l.id, quantity: picks[l.id].qty })),
      });
      toast('ok', `Sales order ${made.number} created`);
      navigate(`/g-ops/sales-orders/${made.id}/edit`);
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  }

  return (
    <div id="qd-create-so" className="qd-route so-create" role="group" aria-label="Create Sales Order">
      <ErrorBox error={error} />
      <p className="qd-route-label">
        Books R{booking.revision} in operations{booking.revisionStatus === 'APPROVED' ? '' : ' (no revision is approved yet — the latest is used)'}.
        {booking.bookedNet > 0 ? ` ${formatMoney(booking.bookedNet)} of ${formatMoney(booking.net)} is already on a sales order;` : ''}{' '}
        a second order on this quotation gets a .1, .2 number.
      </p>
      {nothingLeft ? (
        <>
          <p>Everything on this quotation is already on a sales order. Cancel an order to give its lines back.</p>
          <div className="row so-create-actions">
            <button className="btn btn-sm" onClick={onClose}>
              Close
            </button>
          </div>
        </>
      ) : (
        <>
          <div className="table-wrap">
            <table className="table so-book-table">
              <thead>
                <tr>
                  <th>
                    <Checkbox
                      checked={allOn}
                      onChange={(v) =>
                        setPicks((p) => {
                          const next = { ...p };
                          for (const l of lines) if (l.available > 0) next[l.id] = { on: v, qty: v ? l.available : (p[l.id]?.qty ?? 0) };
                          return next;
                        })
                      }
                      label=""
                    />
                  </th>
                  <th>%</th>
                  <th>Product group</th>
                  <th>Product name</th>
                  <th>Quantity</th>
                  <th>Unit</th>
                  <th className="num">Unit price</th>
                  <th className="num">Amount</th>
                </tr>
              </thead>
              <tbody>
                {groups.map((g) => {
                  const live = g.lines.filter((l) => l.available > 0);
                  const groupOn = live.length > 0 && live.every((l) => picks[l.id]?.on);
                  return [
                    <tr key={`g-${g.name}`} className="so-book-group">
                      <td>
                        <Checkbox
                          checked={groupOn}
                          onChange={(v) =>
                            setPicks((p) => {
                              const next = { ...p };
                              for (const l of live) next[l.id] = { on: v, qty: v ? l.available : (p[l.id]?.qty ?? 0) };
                              return next;
                            })
                          }
                          label=""
                        />
                      </td>
                      <td colSpan={7}>{g.name}</td>
                    </tr>,
                    ...g.lines.map((l) => {
                      const pick = picks[l.id] ?? { on: false, qty: 0 };
                      const gone = l.available <= 0;
                      return (
                        <tr key={l.id} className={gone ? 'faint' : undefined}>
                          <td>
                            <Checkbox checked={pick.on && !gone} onChange={(v) => !gone && setOn(l, v)} label="" />
                          </td>
                          <td>
                            {gone ? (
                              <span className="mono">booked</span>
                            ) : (
                              <span className="so-w so-w-pct">
                              <NumberInput
                                kind="decimal"
                                min={0}
                                max={100}
                                step={5}
                                value={pctOf(l, pick.qty)}
                                aria-label={`${(l.title ?? '').trim() || l.description}: percent of what is left`}
                                onChange={(e) => {
                                  const n = Number(e.target.value);
                                  if (Number.isFinite(n)) setQty(l, (l.available * Math.min(100, Math.max(0, n))) / 100);
                                }}
                              />
                              </span>
                            )}
                          </td>
                          <td>{l.group ?? ''}</td>
                          <td>
                            <div>{(l.title ?? '').trim() || l.description}</div>
                            {(l.title ?? '').trim() && l.description && <div className="faint">{l.description}</div>}
                          </td>
                          <td>
                            <span className="row so-book-qty">
                              {gone ? (
                                <span className="mono">0</span>
                              ) : (
                                <span className="so-w so-w-qty">
                                <NumberInput
                                  kind="quantity"
                                  min={0}
                                  max={l.available}
                                  step={1}
                                  value={pick.qty}
                                  aria-label={`${(l.title ?? '').trim() || l.description}: quantity to book`}
                                  onChange={(e) => {
                                    const n = Number(e.target.value);
                                    if (Number.isFinite(n)) setQty(l, n);
                                  }}
                                />
                                </span>
                              )}
                              <span className="so-book-left" title={`${l.booked} of ${l.quantity} already booked`}>
                                / {l.available}
                              </span>
                            </span>
                          </td>
                          <td>{l.unit}</td>
                          <td className="num mono">{formatMoney(l.unitPrice)}</td>
                          <td className="num so-book-amount">
                            {gone ? (
                              <span className="mono">—</span>
                            ) : (
                              <span className="so-w so-w-amt">
                              <NumberInput
                                kind="money"
                                min={0}
                                max={amountOf(l, l.available)}
                                step={1000}
                                value={amountOf(l, pick.qty)}
                                aria-label={`${(l.title ?? '').trim() || l.description}: amount to book`}
                                onChange={(e) => {
                                  const n = Number(e.target.value);
                                  if (Number.isFinite(n) && l.unitPrice > 0) setQty(l, n / l.unitPrice);
                                }}
                              />
                              </span>
                            )}
                          </td>
                        </tr>
                      );
                    }),
                  ];
                })}
              </tbody>
            </table>
          </div>

          <div className="so-book-foot">
            <div className="so-book-of">
              <div>
                <strong>{pctOfAvailable}%</strong> of available
              </div>
              <div>
                <strong>{pctOfQuote}%</strong> of quote total
              </div>
              <div className="so-book-target">
                <strong>Target order value:</strong>
                <span className="so-w so-w-pct">
                <NumberInput
                  kind="decimal"
                  min={0}
                  max={100}
                  step={5}
                  value={targetPct}
                  placeholder="%"
                  aria-label="Target order value, as a percentage of what is left"
                  onChange={(e) => {
                    setTargetPct(e.target.value);
                    const n = Number(e.target.value);
                    if (e.target.value.trim() !== '' && Number.isFinite(n)) {
                      applyTargetPct(n);
                      setTargetSum('');
                    }
                  }}
                />
                </span>
                <span>or</span>
                <span className="so-w so-w-amt">
                <NumberInput
                  kind="money"
                  min={0}
                  step={1000}
                  value={targetSum}
                  placeholder="Total sum"
                  aria-label="Target order value, as a sum before tax"
                  onChange={(e) => {
                    setTargetSum(e.target.value);
                    const n = Number(e.target.value);
                    if (e.target.value.trim() !== '' && Number.isFinite(n) && availableGrossOfSelected > 0) {
                      applyTargetPct((n / availableGrossOfSelected) * 100);
                      setTargetPct('');
                    }
                  }}
                />
                </span>
              </div>
            </div>
            <div className="so-book-totals">
              <span>Subtotal of selected lines ({selected.length})</span>
              <span className="mono">{formatMoney(selection.subtotal)}</span>
              <span>Discount</span>
              <span className="mono">{formatMoney(selection.discountAmount)}</span>
              <span>{booking.vatInclusive ? 'VAT included' : 'Tax'}</span>
              <span className="mono">{formatMoney(selection.vatAmount)}</span>
              <span className="so-grand">Total (PHP)</span>
              <span className="so-grand mono">{formatMoney(selection.total)}</span>
            </div>
          </div>

          <Checkbox checked={summarise} onChange={setSummarise} label="Summarise the selection into one line worth it" />
          <div className="row so-create-actions">
            <button className="btn btn-primary btn-sm" onClick={() => void proceed()} disabled={busy || selected.length === 0}>
              {busy ? 'Creating…' : 'Proceed'}
            </button>
            <button className="btn btn-sm" onClick={onClose} disabled={busy}>
              Cancel
            </button>
          </div>
        </>
      )}
    </div>
  );
}
