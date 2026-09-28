import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { Link, Navigate, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api, openPdf, qs } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { addDays, dayKeyOf, parseDay } from '../../lib/day';
import { DataList, type Column } from '../../components/DataList';
import { DocumentApproval } from '../../components/ApprovalStepper';
import { ActivityLog } from '../../components/ActivityLog';
import { Stat } from '../../components/charts';
import {
  Checkbox,
  Empty,
  ErrorBox,
  Field,
  Loading,
  Modal,
  StatusBadge,
  formatDate,
  formatDateTime,
  formatMoney,
  useToast,
  type Tone,
} from '../../components/ui';
import { LostReasonModal } from './LostReasonModal';

const OUTCOMES = [
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
const NEXT_OUTCOMES: Record<string, string[]> = {
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
    { key: 'probability', label: 'Prob.', align: 'right', render: (q) => `${q.probability}%` },
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
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [losing, setLosing] = useState(false);
  const [reload, setReload] = useState(0);

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
  // A draft is written on the full-page editor; the dialog only ever holds
  // what may still change once a revision has left draft.
  const draft = quotation.revisions.find((r) => r.status === 'DRAFT') ?? null;
  const editHref = `/g-ops/quotations/${quotation.id}/edit`;

  async function act(fn: () => Promise<unknown>, message: string) {
    try {
      await fn();
      toast('ok', message);
      await load();
    } catch (err) {
      setError(err);
    }
  }

  /** Throws on refusal so LostReasonModal keeps the reason and shows why. */
  async function markLost(reason: string) {
    await api.patch(`/quotations/${quotation!.id}`, { outcome: 'LOST', lostReason: reason });
    setLosing(false);
    toast('ok', `${quotation!.number} marked lost`);
    await load();
  }

  function printPdf() {
    if (!revision) return;
    openPdf(`/api/quotations/${quotation!.id}/revisions/${revision.id}/pdf`, () =>
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
                onClick={() => act(() => api.post(`/quotations/${quotation.id}/revisions`), 'New revision raised')}
              >
                New revision
              </button>
            )}
            {quotation.canEdit &&
              (draft ? (
                <Link className="btn btn-primary" to={editHref}>
                  Modify
                </Link>
              ) : (
                <button className="btn btn-primary" onClick={() => setSettingsOpen(true)}>
                  Modify
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
                        className={`btn btn-sm${r.id === revision?.id ? ' btn-primary' : ''}`}
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
              <Detail label="Probability">{`${quotation.probability}%`}</Detail>
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
                <Detail label="VAT">{revision.vatInclusive ? 'Prices include VAT' : 'Added on top of the prices'}</Detail>
              </dl>
            )}
          </div>
        </div>

        {/* SCORO's strip: how long it sat in each status, and how long it took to close. */}
        {((quotation.stages?.length ?? 0) > 0 || quotation.closedInDays != null) && (
          <div className="kpi-grid qd-stages" aria-label="Days in each status">
            {(quotation.stages ?? []).map((s) => (
              <Stat
                key={s.outcome}
                label={outcomeLabel(s.outcome)}
                value={dayCount(s.days)}
                figure
                accent={STAGE_ACCENT[s.outcome] ?? 'quiet'}
                sub={s.current ? 'so far' : undefined}
              />
            ))}
            {quotation.closedInDays != null && (
              <Stat
                label="Closed in"
                value={dayCount(quotation.closedInDays)}
                figure
                accent={quotation.outcome === 'WON' ? 'ok' : 'danger'}
                sub={quotation.outcome === 'WON' ? 'won' : 'lost'}
              />
            )}
          </div>
        )}

        {/* SCORO's action bar, at the foot of the details it acts on. */}
        <div className="qd-bar">
          <div className="row">
            <ProjectActions quotation={quotation} jobs={jobs} can={can} />
          </div>
          <div className="row">
            <button className="btn" onClick={printPdf} disabled={!revision}>
              PDF
            </button>
            {canSubmit && (
              <button
                className="btn btn-ok"
                onClick={() =>
                  act(
                    () => api.post(`/quotations/${quotation.id}/revisions/${revision!.id}/submit`),
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
      </section>

      {revision && (
        <>
          {revision.status === 'PENDING_APPROVAL' && (
            <div className="alert info">
              Revision {revision.revision} is with the approver. It cannot be edited until they
              decide — raise a new revision if something must change.
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

          <div className="kpi-grid">
            <Stat
              label="Subtotal"
              value={formatMoney(revision.subtotal)}
              figure
              sub={revision.discountAmount > 0 ? `less ${formatMoney(revision.discountAmount)} discount` : 'no discount'}
            />
            <Stat
              label={`VAT ${(revision.vatRate * 100).toFixed(0)}%`}
              value={formatMoney(revision.vatAmount)}
              figure
              sub={revision.vatInclusive ? 'backed out of the prices' : 'added on'}
            />
            <Stat label="Total" value={formatMoney(revision.total)} figure accent="neon" />
            {showCost && <MarginStat panel={revision.costPanel} costing={revision.costing} />}
          </div>

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
                      <th>Product | Description</th>
                      <th className="right">Qty | Unit</th>
                      <th className="right">Unit price</th>
                      <th className="right">Amount</th>
                      {showCost && <th>Cost &amp; provider</th>}
                      {showCost && <th className="right">Margin</th>}
                      {editable && <th className="sales-col-action" />}
                    </tr>
                  </thead>
                  <tbody>
                    {revision.items.map((item, i) => (
                      <tr key={item.id}>
                        <td className="mono">{i + 1}</td>
                        <td>{item.group || <span className="faint">—</span>}</td>
                        <td>
                          {item.title && <div className="quote-line-title">{item.title}</div>}
                          {item.description && <div className="quote-line-desc">{item.description}</div>}
                        </td>
                        <td className="right mono">
                          {item.quantity} <span className="faint">{item.unit}</span>
                        </td>
                        <td className="right mono">{formatMoney(item.unitPrice)}</td>
                        <td className="right mono">{formatMoney(item.amount)}</td>
                        {showCost && (
                          <td>
                            <LineCost item={item} />
                          </td>
                        )}
                        {showCost && (
                          <td className="right mono">
                            {item.margin == null ? (
                              <span className="faint">—</span>
                            ) : (
                              <>
                                <div className={item.margin < 0 ? 'quote-negative' : undefined}>{formatMoney(item.margin)}</div>
                                <div className="faint">{pct(item.marginPct)}</div>
                              </>
                            )}
                          </td>
                        )}
                        {editable && (
                          <td>
                            <Link
                              className="btn btn-sm"
                              to={`${editHref}#line-${i + 1}`}
                              aria-label={`Modify line ${i + 1}`}
                            >
                              Modify
                            </Link>
                          </td>
                        )}
                      </tr>
                    ))}
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

          <div className="sales-card-gap">
            <ActivityLog quotationId={quotation.id} canEdit={quotation.canEdit} />
          </div>
        </>
      )}

      {settingsOpen && revision && (
        <QuotationSettings
          quotation={quotation}
          revision={revision}
          onClose={() => setSettingsOpen(false)}
          onSaved={() => {
            setSettingsOpen(false);
            void load();
          }}
        />
      )}

      {losing && (
        <LostReasonModal
          what={quotation.number}
          initial={quotation.lostReason ?? ''}
          onClose={() => setLosing(false)}
          onSave={markLost}
        />
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
              <input
                type="number"
                min={0}
                max={100}
                step="0.01"
                inputMode="decimal"
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

/**
 * The margin tile. The quotation's own cost panel when its lines are costed
 * (SCORO's way), else the linked costing's figures. Only rendered for a viewer
 * the server sent cost to.
 */
function MarginStat({
  panel,
  costing,
}: {
  panel?: CostPanel;
  costing: { contractValue: number; totalCost?: number } | null;
}) {
  let profit: number;
  let pctValue: number;
  let source: string;
  if (panel && panel.costedLines > 0) {
    profit = panel.totalMargin;
    pctValue = (panel.totalMarginPct ?? 0) / 100;
    source = `on the lines (${panel.costedLines} of ${panel.lineCount} costed)`;
  } else if (costing && costing.totalCost != null) {
    profit = costing.contractValue - costing.totalCost;
    pctValue = costing.contractValue > 0 ? profit / costing.contractValue : 0;
    source = 'on the costing';
  } else {
    return <Stat label="Margin" value="—" sub="no line costs or costing yet" />;
  }
  const accent = pctValue < 0 ? 'danger' : pctValue < 0.1 ? 'warn' : 'ok';
  return (
    <Stat
      label="Margin"
      value={`${(pctValue * 100).toFixed(1)}%`}
      figure
      accent={accent}
      sub={`${formatMoney(profit)} ${source}${pctValue < 0 ? ' — below cost' : pctValue < 0.1 ? ' — under 10%' : ''}`}
    />
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

/** The strip's colours follow the status pill's: open waits on us, the rest are the lifecycle. */
const STAGE_ACCENT: Record<string, 'ok' | 'warn' | 'danger' | 'info' | 'neon' | 'quiet'> = {
  OPEN: 'warn',
  SUBMITTED: 'info',
  NEGOTIATION: 'neon',
};

// ── Modals ───────────────────────────────────────────────────────────────────

function QuotationSettings({
  quotation,
  revision,
  onClose,
  onSaved,
}: {
  quotation: QuotationDetail;
  revision: Revision;
  onClose: () => void;
  onSaved: () => void;
}) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [costings, setCostings] = useState<{ id: string; number: string; title: string }[]>([]);
  const [form, setForm] = useState({
    subject: quotation.subject,
    probability: quotation.probability.toString(),
    expectedClosing: quotation.expectedClosing?.slice(0, 10) ?? '',
    costingId: revision.costing?.id ?? '',
    validityDays: revision.validityDays.toString(),
    terms: revision.terms ?? '',
    notes: revision.notes ?? '',
    vatInclusive: revision.vatInclusive,
    prNumber: revision.prNumber ?? '',
    delivery: revision.delivery ?? '',
    // The customer's own terms, unless this revision already says otherwise.
    paymentTerms: revision.paymentTerms ?? quotation.customer.paymentTerms ?? '',
  });

  useEffect(() => {
    api.get<typeof costings>('/costings/lookup').then(setCostings).catch(() => {});
  }, []);

  const editableRevision = revision.status === 'DRAFT';

  async function save() {
    setBusy(true);
    setError(null);
    try {
      await api.patch(`/quotations/${quotation.id}`, {
        subject: form.subject,
        probability: Number(form.probability),
        expectedClosing: form.expectedClosing || null,
      });
      if (editableRevision) {
        await api.patch(`/quotations/${quotation.id}/revisions/${revision.id}`, {
          costingId: form.costingId || null,
          validityDays: Number(form.validityDays),
          terms: form.terms || null,
          notes: form.notes || null,
          vatInclusive: form.vatInclusive,
          prNumber: form.prNumber || null,
          delivery: form.delivery || null,
          paymentTerms: form.paymentTerms || null,
        });
      }
      toast('ok', 'Saved');
      onSaved();
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  }

  return (
    <Modal
      wide
      title={`Modify ${quotation.number}`}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button className="btn btn-primary" onClick={save} disabled={busy}>
            {busy ? 'Saving…' : 'Save'}
          </button>
        </>
      }
    >
      <ErrorBox error={error} />
      {!editableRevision && (
        <div className="alert info">
          Revision {revision.revision} is {revision.status.toLowerCase().replace(/_/g, ' ')}, so its
          commercial terms are locked. Only the subject, probability and expected closing can change
          here.
        </div>
      )}

      <div className="grid grid-2">
        <Field label="Subject">
          <input value={form.subject} onChange={(e) => setForm({ ...form, subject: e.target.value })} />
        </Field>
        <Field label="Probability %" hint="Your own read — the weighted pipeline multiplies by it">
          <input
            type="number"
            min={0}
            max={100}
            value={form.probability}
            onChange={(e) => setForm({ ...form, probability: e.target.value })}
          />
        </Field>
        <Field label="Expected closing" hint="When you expect the decision — the pipeline forecast reads it">
          <input
            type="date"
            value={form.expectedClosing}
            onChange={(e) => setForm({ ...form, expectedClosing: e.target.value })}
          />
        </Field>
        <Field label="Costing" hint="Where the price and the margin come from">
          <select
            value={form.costingId}
            disabled={!editableRevision}
            onChange={(e) => setForm({ ...form, costingId: e.target.value })}
          >
            <option value="">— none —</option>
            {costings.map((c) => (
              <option key={c.id} value={c.id}>
                {c.number} — {c.title}
              </option>
            ))}
          </select>
        </Field>
        <Field label="PR number" hint="The customer's purchase request reference — printed on the quotation">
          <input
            value={form.prNumber}
            disabled={!editableRevision}
            onChange={(e) => setForm({ ...form, prNumber: e.target.value })}
          />
        </Field>
        <Field
          label="Payment terms"
          hint={quotation.customer.paymentTerms ? `The customer's usual: ${quotation.customer.paymentTerms}` : undefined}
        >
          <input
            value={form.paymentTerms}
            disabled={!editableRevision}
            onChange={(e) => setForm({ ...form, paymentTerms: e.target.value })}
          />
        </Field>
        <Field label="Delivery" hint="e.g. 4 to 6 weeks upon receipt of PO">
          <input
            value={form.delivery}
            disabled={!editableRevision}
            onChange={(e) => setForm({ ...form, delivery: e.target.value })}
          />
        </Field>
        <Field label="Validity (days)">
          <input
            type="number"
            disabled={!editableRevision}
            value={form.validityDays}
            onChange={(e) => setForm({ ...form, validityDays: e.target.value })}
          />
        </Field>
      </div>

      <Field label="Terms and conditions">
        <textarea
          value={form.terms}
          disabled={!editableRevision}
          onChange={(e) => setForm({ ...form, terms: e.target.value })}
        />
      </Field>
      <Field label="Notes">
        <textarea
          value={form.notes}
          disabled={!editableRevision}
          onChange={(e) => setForm({ ...form, notes: e.target.value })}
        />
      </Field>

      <Checkbox
        checked={form.vatInclusive}
        onChange={(v) => editableRevision && setForm({ ...form, vatInclusive: v })}
        label="Prices are VAT inclusive — the tax is backed out rather than added on"
      />
    </Modal>
  );
}
