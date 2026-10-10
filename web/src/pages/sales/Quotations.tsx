import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { Link, Navigate, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { ApiError, api, qs } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { addDays, dayKeyOf, parseDay } from '../../lib/day';
import { DataList, type BulkContext, type Column, type FilterDef } from '../../components/DataList';
import { Stat, noTeamNote, teamCards, type TeamShare } from '../../components/charts';
import { ApprovalStepper, DocumentApproval } from '../../components/ApprovalStepper';
import { ActivityLog } from '../../components/ActivityLog';
import { RecordHeader } from '../../components/RecordHeader';
import { useConfirm } from '../../components/Confirm';
import { SO_TONES, type SalesOrderRow } from './SalesOrders';
import { loadPeople } from '../../components/People';
import { Checkbox, Empty, ErrorBox, Loading, PdfButton, StatusBadge, formatDate, formatDateTime, formatMoney, initials, useToast, type Tone } from '../../components/ui';
import type { CostPanel } from '../../lib/quotationMath';

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
  /** The pipeline stage it stands in — the board's band, worked out by the server — and its name. */
  stage: string;
  stageLabel: string | null;
  probability: number;
  expectedClosing: string | null;
  customer: { id: string; name: string };
  contact: { id: string; name: string } | null;
  owner: { id: string; name: string };
  createdAt: string;
  updatedAt: string;
  legacyQuote: LegacyRef | null;
  /** `quotationValue()`: the approved revision's total, else the latest's. */
  value: number;
  /** The revision the value comes from — and the one the PDF icon prints. */
  valueRevision: { id: string; revision: number; status: string } | null;
  latest: { revision: number; status: string; total: number; updatedAt: string } | null;
  salesOrderCount: number;
  /** The sales orders still standing on it — the S.O. column beside PDF. */
  salesOrders: { id: string; number: string; status: string }[];
  /** Only for a viewer who may see this quotation's cost; null otherwise or when no line is costed. */
  margin: { amount: number; pct: number | null; costedLines: number; lineCount: number } | null;
  /** What Change status plans with; the PATCH still decides. */
  canEdit: boolean;
  hasApprovedRevision: boolean;
  hasJob: boolean;
}

/** The SCORO quote a live quotation carries on, under the same number. */
interface LegacyRef {
  id: string;
  number: string;
  status: string;
}

/**
 * A stage on the shared pill (rule 12). The colour of each stage is the
 * administrator's (it tints the tab); the pill keeps the lifecycle tones so
 * it reads the same as every other status in the app.
 */
export const STAGE_TONES: Record<string, Tone> = {
  OPPORTUNITY: '',
  NEGOTIATION: 'warn',
  CLOSING: 'info',
  CONFIRMED: 'ok',
  COMPLETED: 'ok',
  LOST: 'danger',
};

/** SCORO's statuses, for the tabs before the list's first answer names them. */
const STAGE_TABS = [
  { value: 'OPPORTUNITY', label: 'Opportunity' },
  { value: 'NEGOTIATION', label: 'Negotiation' },
  { value: 'CLOSING', label: 'Closing' },
  { value: 'CONFIRMED', label: 'Confirmed' },
  { value: 'COMPLETED', label: 'Completed' },
  { value: 'LOST', label: 'Lost' },
];

/**
 * The stage each fine outcome stands in — the board's band and the list's
 * tab, which the quotation page prints as its status too (2026-10-08, the
 * owner's call: a drag on the board and the quotation must say the same
 * word). Fixed: an administrator renames and recolours stages, never which
 * statuses they gather (`quotationStage` in api/src/shared/pipeline.ts). The
 * names come from the server where it sends them (`quotationStages`), so a
 * renamed stage is renamed here; SCORO's defaults otherwise.
 */
export const OUTCOME_STAGE: Record<string, string> = {
  OPEN: 'OPPORTUNITY',
  SUBMITTED: 'NEGOTIATION',
  NEGOTIATION: 'CLOSING',
  WON: 'CONFIRMED',
  LOST: 'LOST',
};

/** A stage as `GET /quotations/:id` sends it: named by Admin › Pipeline Stages, with the outcomes it gathers. */
export interface StageOption {
  key: string;
  label: string;
  color?: string;
  outcomes?: string[];
}

/** The stage key an outcome stands in (unbooked — a won quotation with an order is Completed, which the server says). */
export function stageKeyFor(outcome: string, stages?: StageOption[] | null): string {
  return stages?.find((s) => s.outcomes?.includes(outcome))?.key ?? OUTCOME_STAGE[outcome] ?? outcome;
}

/** The stage's name for an outcome — "Closing" for NEGOTIATION — as the server names it, else SCORO's default. */
export function stageLabelFor(outcome: string, stages?: StageOption[] | null): string {
  const key = stageKeyFor(outcome, stages);
  return stages?.find((s) => s.key === key)?.label ?? STAGE_TABS.find((t) => t.value === key)?.label ?? outcomeLabel(outcome);
}

interface QuotationSummary {
  count?: number;
  value?: number;
  /** Only where the viewer may see every listed quotation's cost. */
  margin?: { amount: number; pct: number | null; costed: number };
  /** The viewer's team's share of the set; only for a viewer with a team. */
  team?: { count: number; value: number };
  /** The set split by the owner's team — every active team, "No team" last while anybody has none. */
  teams?: TeamShare[];
  /** The stages as Admin › Pipeline Stages names them — the Stage filter's choices. */
  tabs?: { value: string; label: string }[];
}

/**
 * The list of quotations, after SCORO's (2026-10-08): the summary cards over
 * the table — the count, the sum, the margin and the quotes by team — one
 * Filters panel (the stage among them), the customer and status in columns
 * of their own. The cards, the filters and the printed list all come from
 * the server's one list query.
 */
export function Quotations() {
  const { me, can } = useAuth();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const [owners, setOwners] = useState<{ value: string; label: string }[]>([]);
  // The stages as the server names them (Admin › Pipeline Stages); the
  // defaults stand in until the first answer arrives.
  const [stageOptions, setStageOptions] = useState<{ value: string; label: string }[]>(STAGE_TABS);

  const seesAll = can('gops.quotations.view_all');
  // The owner's call: whoever may edit quotations opens on their own; a
  // reader (finance, an executive) opens on all of them. A link's ?scope= wins.
  const mayEdit = can('gops.quotations.edit_own') || can('gops.quotations.edit_all');
  const seesCost = mayEdit || can('gops.costing.view_all');

  useEffect(() => {
    if (!seesAll) return;
    loadPeople('gops.quotations.create')
      .then((people) => setOwners(people.map((p) => ({ value: p.id, label: p.name }))))
      .catch(() => setOwners([]));
  }, [seesAll]);

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
      label: 'No.',
      sortKey: 'number',
      width: '140px',
      render: (q) => (
        <div>
          <span className="mono">{q.number}</span>
          {q.legacyQuote && <div className="faint">from SCORO</div>}
        </div>
      ),
    },
    {
      key: 'subject',
      label: 'Quote / Project',
      sortKey: 'subject',
      render: (q) => (
        <div>
          <div>{q.subject}</div>
          {q.contact && <div className="faint">{q.contact.name}</div>}
        </div>
      ),
    },
    { key: 'customer', label: 'Customer', sortKey: 'customer', render: (q) => q.customer.name },
    {
      key: 'stage',
      label: 'Status',
      render: (q) => <StatusBadge status={q.stage || q.outcome} extra={STAGE_TONES} label={q.stageLabel ?? undefined} />,
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
      render: (q) => (q.valueRevision ? <span className="mono">{formatMoney(q.value)}</span> : '—'),
    },
    ...(seesCost
      ? [
          {
            key: 'margin',
            label: 'Margin',
            align: 'right' as const,
            render: (q: QuotationRow) =>
              q.margin ? (
                <span title={`${q.margin.costedLines} of ${q.margin.lineCount} lines costed`}>
                  <span className="mono">{formatMoney(q.margin.amount)}</span>
                  {q.margin.pct !== null && <div className="faint">{q.margin.pct}%</div>}
                </span>
              ) : (
                <span className="faint">—</span>
              ),
          },
        ]
      : []),
    { key: 'probability', label: 'Probability', sortKey: 'probability', align: 'right', optional: true, render: (q) => `${q.probability}%` },
    // The owner's heads (2026-10-09): Author as initials only, the full name in the tooltip.
    {
      key: 'owner',
      label: 'Author',
      width: '72px',
      render: (q) => (
        <abbr title={q.owner.name} className="mono">
          {initials(q.owner.name)}
        </abbr>
      ),
    },
    {
      key: 'expectedClosing',
      label: 'Closing',
      sortKey: 'expectedClosing',
      render: (q) => (q.expectedClosing ? formatDate(q.expectedClosing) : <span className="faint">—</span>),
    },
    { key: 'createdAt', label: 'Issue date', sortKey: 'createdAt', render: (q) => formatDate(q.createdAt) },
    { key: 'updatedAt', label: 'Modified', sortKey: 'updatedAt', optional: true, render: (q) => formatDate(q.updatedAt) },
    {
      key: 'pdf',
      label: 'PDF',
      align: 'center',
      width: '56px',
      render: (q) =>
        q.valueRevision ? (
          <PdfButton path={`/api/quotations/${q.id}/revisions/${q.valueRevision.id}/pdf`} label={`Open the PDF of ${q.number}`} />
        ) : null,
    },
    {
      // The sales orders booked on it, beside the PDF (2026-10-09, the owner's call).
      key: 'salesOrders',
      label: 'S.O.',
      width: '110px',
      render: (q) =>
        q.salesOrders.length ? (
          <div className="mono">
            {q.salesOrders.map((o) => (
              <div key={o.id}>
                <Link to={`/g-ops/sales-orders/${o.id}`} onClick={(e) => e.stopPropagation()} title={`Sales order ${o.number} · ${o.status.toLowerCase().replace(/_/g, ' ')}`}>
                  {o.number}
                </Link>
              </div>
            ))}
          </div>
        ) : (
          <span className="faint">—</span>
        ),
    },
  ];

  const filters: FilterDef[] = [
    { key: 'stage', label: 'Stage', options: stageOptions },
    // Declared before its people arrive, so a linked ?ownerId= is read on mount (rule 16).
    ...(seesAll ? [{ key: 'ownerId', label: 'Owner', options: owners }] : []),
    ...(can('gops.customers.view_all')
      ? [
          {
            key: 'customerId',
            label: 'Customer',
            type: 'lookup' as const,
            placeholder: 'Type a customer name or code…',
            search: async (term: string) =>
              (await api.get<{ id: string; code: string; name: string }[]>(`/customers/lookup${qs({ q: term })}`)).map(
                (c) => ({ value: c.id, label: `${c.name} · ${c.code}` }),
              ),
            describe: async (id: string) => {
              const c = await api.get<{ name: string; code: string }>(`/customers/${id}`);
              return `${c.name} · ${c.code}`;
            },
          },
        ]
      : []),
    { key: 'createdFrom', toKey: 'createdTo', label: 'Raised', type: 'dateRange' },
    { key: 'closingFrom', toKey: 'closingTo', label: 'Expected closing', type: 'dateRange' },
    {
      key: 'revision',
      label: 'Revision',
      options: [
        { value: 'DRAFT', label: 'Has a draft' },
        { value: 'PENDING_APPROVAL', label: 'Pending approval' },
        { value: 'APPROVED', label: 'Has an approved revision' },
      ],
    },
    {
      key: 'salesOrder',
      label: 'Sales order',
      options: [
        { value: 'yes', label: 'Booked in a sales order' },
        { value: 'no', label: 'No sales order yet' },
      ],
    },
  ];

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Quotations</h1>
        </div>
      </div>

      <DataList<QuotationRow>
        listKey="quotations"
        endpoint="/quotations"
        columns={columns}
        rowKey={(q) => q.id}
        scoped
        defaultScope={mayEdit ? 'mine' : 'all'}
        searchPlaceholder="Search number, name, customer, contact…"
        onRowClick={(q) => navigate(`/g-ops/quotations/${q.id}`)}
        emptyTitle="No quotations yet"
        filters={filters}
        printPath="/api/quotations/pdf"
        selectable
        rowLabel={(q) => `${q.number} ${q.subject}`}
        bulkActions={(ctx) => <QuotationBulkStatus ctx={ctx} />}
        teamScope={seesAll && !!me?.user.team}
        onSummary={(raw) => {
          const named = (raw as QuotationSummary).tabs;
          if (named?.length) setStageOptions(named.map((t) => ({ value: t.value, label: t.label })));
        }}
        summary={(raw, total) => {
          const s = raw as QuotationSummary;
          return (
            <>
              <Stat
                label="Quotations"
                value={total}
                sub={noTeamNote(s.teams)}
              />
              <Stat label="Sum" value={formatMoney(s.value ?? 0)} figure />
              {s.margin && (
                <Stat
                  label="Margin"
                  value={formatMoney(s.margin.amount)}
                  figure
                  sub={`${s.margin.pct !== null ? `${s.margin.pct}% · ` : ''}${s.margin.costed} costed`}
                />
              )}
              {teamCards(s.teams, formatMoney)}
            </>
          );
        }}
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

// ── Mass actions: Change status ──────────────────────────────────────────────

/** The statuses a quotation can be moved to — the detail page's Change status, for many. */
const BULK_TARGETS = ['SUBMITTED', 'NEGOTIATION', 'WON', 'LOST'];

/**
 * Which ticked quotations a move would take, and why the rest stay — the same
 * rules as the detail page's menu (NEXT_OUTCOMES, Won needs an approved
 * revision, a quotation built into a project stays won), so the button says
 * what will happen before anything is sent. The PATCH still decides each one.
 */
export function planMove(
  rows: QuotationRow[],
  target: string,
): { go: QuotationRow[]; stay: { row: QuotationRow; why: string }[] } {
  const go: QuotationRow[] = [];
  const stay: { row: QuotationRow; why: string }[] = [];
  for (const r of rows) {
    if (r.outcome === target) stay.push({ row: r, why: `already in ${stageLabelFor(target)}` });
    else if (!r.canEdit) stay.push({ row: r, why: 'only its author can move it' });
    else if (r.outcome === 'WON' && r.hasJob) stay.push({ row: r, why: 'a project was built from it' });
    else if (!(NEXT_OUTCOMES[r.outcome] ?? []).includes(target)) {
      stay.push({ row: r, why: `${r.stageLabel ?? stageLabelFor(r.outcome)} cannot go to ${stageLabelFor(target)}` });
    } else if (target === 'WON' && !r.hasApprovedRevision) stay.push({ row: r, why: 'needs an approved revision first' });
    else go.push(r);
  }
  return { go, stay };
}

/**
 * Change status on the ticked quotations, one ordinary PATCH each — the move
 * rules, the lead that follows, the stage's odds and the audit row are the
 * PATCH's, exactly as when one quotation is moved from its page. Lost asks
 * its reason once, in the bar. Whatever did not move stays ticked, with why.
 */
function QuotationBulkStatus({ ctx }: { ctx: BulkContext<QuotationRow> }) {
  const toast = useToast();
  const [target, setTarget] = useState('');
  const [reason, setReason] = useState('');
  const [progress, setProgress] = useState<{ done: number; of: number } | null>(null);
  const [refused, setRefused] = useState<{ number: string; why: string }[]>([]);

  const plan = target ? planMove(ctx.rows, target) : null;
  const needsReason = target === 'LOST';

  async function apply() {
    if (!plan || !plan.go.length || (needsReason && !reason.trim())) return;
    const failed: { row: QuotationRow; why: string }[] = [];
    let moved = 0;
    setRefused([]);
    for (let i = 0; i < plan.go.length; i++) {
      setProgress({ done: i, of: plan.go.length });
      const row = plan.go[i];
      try {
        await api.patch(`/quotations/${row.id}`, needsReason ? { outcome: target, lostReason: reason.trim() } : { outcome: target });
        moved++;
      } catch (err) {
        failed.push({ row, why: err instanceof ApiError ? err.message : 'could not be moved' });
      }
    }
    setProgress(null);
    const left = [...plan.stay, ...failed];
    toast(
      moved > 0 ? 'ok' : 'error',
      `${moved} quotation${moved === 1 ? '' : 's'} moved to ${stageLabelFor(target)}` +
        (left.length ? `; ${left.length} did not move` : ''),
    );
    setRefused(left.map((l) => ({ number: l.row.number, why: l.why })));
    setTarget('');
    setReason('');
    ctx.reload();
    if (left.length) ctx.keep(left.map((l) => l.row.id));
    else ctx.clear();
  }

  return (
    <>
      <select
        aria-label="Change status of the selected quotations"
        value={target}
        disabled={!!progress}
        onChange={(e) => {
          setTarget(e.target.value);
          setRefused([]);
        }}
      >
        <option value="">Change status…</option>
        {BULK_TARGETS.map((o) => (
          <option key={o} value={o}>
            {stageLabelFor(o)}
            {o === 'LOST' ? '…' : ''}
          </option>
        ))}
      </select>
      {needsReason && (
        <input
          type="text"
          className="list-bulk-reason"
          aria-label="Why were they lost? One reason for all of them"
          placeholder="Why were they lost? (one reason for all)"
          value={reason}
          disabled={!!progress}
          onChange={(e) => setReason(e.target.value)}
        />
      )}
      {plan && (
        <button
          type="button"
          className={`btn btn-sm ${target === 'LOST' ? 'btn-danger' : 'btn-primary'}`}
          disabled={!plan.go.length || !!progress || (needsReason && !reason.trim())}
          onClick={() => void apply()}
        >
          {progress
            ? `Moving ${progress.done + 1} of ${progress.of}…`
            : plan.go.length
              ? `Move ${plan.go.length} to ${outcomeLabel(target)}`
              : 'None can move there'}
        </button>
      )}
      {plan && plan.stay.length > 0 && !progress && (
        <p className="list-bulk-result">
          {plan.stay.length} will stay as they are:{' '}
          {plan.stay
            .slice(0, 6)
            .map((st) => `${st.row.number} (${st.why})`)
            .join(', ')}
          {plan.stay.length > 6 ? `, and ${plan.stay.length - 6} more` : ''}.
        </p>
      )}
      {!plan && refused.length > 0 && (
        <div className="list-bulk-result" role="status">
          Still selected — these did not move:
          <ul>
            {refused.map((r) => (
              <li key={r.number}>
                <span className="mono">{r.number}</span>: {r.why}
              </li>
            ))}
          </ul>
        </div>
      )}
    </>
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
  /** The three boxes (2026-10-08); `title` is their sentence, or the title typed before them. */
  brand?: string | null;
  productType?: string | null;
  partNumber?: string | null;
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
  /** The pipeline stage it stands in — the word the board and the list use — and its name. Booked-aware (Completed). */
  stage?: string;
  stageLabel?: string | null;
  /** The stages a quotation can stand in, as Admin › Pipeline Stages names them, each with the outcomes it gathers. */
  quotationStages?: StageOption[];
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
  // `?order=1` opens the Create Sales Order panel: the sales order list's
  // "+ New sales order" lands here with the quotation chosen (2026-10-09).
  const [params] = useSearchParams();
  const { can } = useAuth();
  const toast = useToast();
  // Delete, Lost and the rarer moves ask here, in the bar under the header.
  const confirm = useConfirm();
  // Another record opened in this same page (a bell, Ctrl+K) withdraws a question about the last one.
  const closeConfirm = confirm.close;
  useEffect(() => closeConfirm(), [id, closeConfirm]);

  const [quotation, setQuotation] = useState<QuotationDetail | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [optionId, setOptionId] = useState<string | null>(null);
  const [bookingOrder, setBookingOrder] = useState(params.get('order') === '1');
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
  // The quotation's value: the approved revision, else the latest (`quotationValue()` on the server).
  const valueRevision =
    approved ??
    quotation.revisions.reduce<Revision | null>((best, r) => (best === null || r.revision > best.revision ? r : best), null);
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

  /** Does it, says so, reloads — and throws, so a confirm bar can show the refusal. */
  async function run(fn: () => Promise<unknown>, message: string) {
    await fn();
    toast('ok', message);
    await load();
  }

  /** The same, for a button that acts at once: a refusal goes to the page's error box. */
  async function act(fn: () => Promise<unknown>, message: string) {
    try {
      await run(fn, message);
    } catch (err) {
      setError(err);
    }
  }

  async function markLost(reason: string) {
    await api.patch(`/quotations/${quotation!.id}`, { outcome: 'LOST', lostReason: reason });
    toast('ok', `${quotation!.number} marked lost`);
    await load();
  }

  async function remove() {
    await api.del(`/quotations/${quotation!.id}`);
    toast('ok', `${quotation!.number} deleted`);
    navigate('/g-ops/quotations');
  }

  // The option ticked under the header ("Add the CEO as approver") routes the
  // submit and the draft's PDF alike; one that no longer applies is dropped.
  const chosenOption = optionId && (quotation.approvalOptions ?? []).some((o) => o.id === optionId) ? optionId : null;

  // The page speaks in STAGES (2026-10-08) — the board's and the list's
  // words — while every value stays the fine outcome the PATCH takes.
  const stageLabelOf = (o: string) => stageLabelFor(o, quotation!.quotationStages);
  // A quotation that became a project stays won — no moves at all.
  const moves = (quotation.outcome === 'WON' && jobs.length > 0 ? [] : (NEXT_OUTCOMES[quotation.outcome] ?? [])).map(
    (o) => ({ value: o, label: stageLabelOf(o) }),
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

  // Lost is the ⋯ menu's "Mark lost" (red, asking why in the bar under the
  // header); the Change status select carries only the moves that destroy nothing.
  const canMarkLost = quotation.canEdit && moves.some((m) => m.value === 'LOST');
  const statusMoves = moves.filter((m) => m.value !== 'LOST');

  function changeOutcome(next: string) {
    if (!next) return;
    void act(
      () => api.patch(`/quotations/${quotation!.id}`, { outcome: next }),
      reopening ? 'Reopened' : `Moved to ${stageLabelOf(next)}`,
    );
  }

  // ── The header's buttons ──────────────────────────────────────────────────
  const hasPricedLine = quotation.revisions.some((r) => r.items.some((i) => !i.isHeading));
  const canOrder = can('gops.sales_orders.create');
  // Any quotation still on may be ordered (2026-10-09, the owner's call: one
  // under negotiation included); approval of the order builds the project.
  const canRequestJobOrder = quotation.outcome !== 'LOST' && jobs.length === 0 && can('gops.job_orders.create');
  // A won quotation not yet delivered becomes a project from its approved revision's costing.
  const canCreateProject = quotation.outcome === 'WON' && !!approved && jobs.length === 0 && can('gops.projects.create');
  // ONE main next step, in the order a quotation lives them: approve the
  // draft, send it, then book the won work.
  const primary = canSubmit ? 'submit' : canSend ? 'send' : quotation.outcome === 'WON' && canOrder && hasPricedLine ? 'order' : null;
  const pendingLatest = quotation.revisions[0]?.status === 'PENDING_APPROVAL' ? quotation.revisions[0] : null;
  const raiseRevision = () =>
    run(
      () => api.post(`/quotations/${quotation.id}/revisions`),
      // The server withdraws a pending revision's approval request as it
      // supersedes it; say so, since the approver is told.
      pendingLatest ? `New revision raised — R${pendingLatest.revision} is withdrawn from approval` : 'New revision raised',
    );
  const fillFromCosting = () =>
    run(
      () => api.post(`/quotations/${quotation.id}/revisions/${revision!.id}/from-costing`),
      'Filled from the costing scope of work',
    );

  return (
    <div>
      <RecordHeader
        type="Quotation"
        code={`${quotation.number}${revision ? ` R${revision.revision}` : ''}`}
        title={quotation.subject}
        // The STAGE — the word the board and the list use.
        status={quotation.stage || stageKeyFor(quotation.outcome, quotation.quotationStages)}
        statusLabel={quotation.stageLabel ?? stageLabelOf(quotation.outcome)}
        statusExtra={STAGE_TONES}
        amount={valueRevision ? formatMoney(valueRevision.total) : undefined}
        amountLabel={valueRevision ? `Total · R${valueRevision.revision}${valueRevision.status === 'APPROVED' ? ' approved' : ''}` : undefined}
        meta={
          <>
            <Link to={`/g-ops/customers/${quotation.customer.id}`}>{quotation.customer.name}</Link>
            {quotation.contact && ` · ${quotation.contact.name}`}
            {quotation.lead && (
              <>
                {' '}
                · from <Link to={`/g-ops/leads/${quotation.lead.id}`}>{quotation.lead.number}</Link>
              </>
            )}
            {revision?.costing && (
              <>
                {' '}
                · costing <Link to={`/g-ops/costing/${revision.costing.id}`}>{revision.costing.number}</Link>
              </>
            )}
            {jobs.map((j) => (
              <span key={j.id}>
                {' '}
                · project <Link to={`/g-ops/projects/${j.id}`}>{j.number}</Link>
              </span>
            ))}
          </>
        }
        actions={
          <>
            {canSubmit && (
              <button
                className={`btn${primary === 'submit' ? ' btn-primary' : ''}`}
                onClick={() =>
                  act(
                    () => api.post(`/quotations/${quotation.id}/revisions/${revision!.id}/submit`, { optionId: chosenOption }),
                    'Submitted for approval',
                  )
                }
              >
                Submit for approval
              </button>
            )}
            {canSend && (
              <button
                className={`btn${primary === 'send' ? ' btn-primary' : ''}`}
                title="Records that the customer has it. Email the PDF as you always have."
                onClick={() => act(() => api.patch(`/quotations/${quotation.id}`, { outcome: 'SUBMITTED' }), 'Marked as sent')}
              >
                Mark as sent
              </button>
            )}
            {canOrder && (
              <button
                className={`btn${primary === 'order' ? ' btn-primary' : ''}`}
                aria-expanded={bookingOrder}
                aria-controls="qd-create-so"
                onClick={() => setBookingOrder((v) => !v)}
                disabled={!hasPricedLine}
                title="Book this quotation in operations — SCORO's Create invoice"
              >
                Create Sales Order
              </button>
            )}
            {canRequestJobOrder && (
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
            )}
            {canCreateProject && approved && (
              <Link
                className="btn"
                to={`/g-ops/projects${qs({ new: 1, costingId: approved.costing?.id, quotationRevisionId: approved.id })}`}
                title={`R${approved.revision} is the approved revision — its costing carries the budget and the schedule of values into the project`}
              >
                Create project
              </Link>
            )}
          </>
        }
        print={revision ? `/api/quotations/${quotation.id}/revisions/${revision.id}/pdf${qs({ option: chosenOption })}` : undefined}
        more={[
          can('gops.quotations.create') &&
            revision && {
              label: 'Duplicate',
              hint: "A new quotation with this one's customer, terms and lines — numbered when you save it",
              to: `/g-ops/quotations/new${qs({ duplicate: quotation.id, revision: revision.id })}`,
            },
          // The sales order's own item, in the same place: the same revision
          // back to draft, no number burned on what the customer never saw.
          quotation.canEdit &&
            pendingLatest && {
              label: 'Pull back and edit',
              hint: 'Withdraw it from the approvers and return it to draft',
              confirm: {
                title: `Pull R${pendingLatest.revision} back to draft?`,
                body: 'It is withdrawn from the approvers — they are told — and nothing can be approved until you submit it again.',
                confirmLabel: 'Pull back',
                tone: 'primary' as const,
                onConfirm: () =>
                  run(
                    () => api.post(`/quotations/${quotation.id}/revisions/${pendingLatest.id}/withdraw`),
                    `R${pendingLatest.revision} pulled back to draft`,
                  ),
              },
            },
          quotation.canEdit &&
            revision?.status !== 'DRAFT' &&
            (pendingLatest
              ? {
                  label: 'New revision',
                  hint: `R${pendingLatest.revision} is withdrawn from approval`,
                  confirm: {
                    title: `Raise a new revision of ${quotation.number}?`,
                    body: `R${pendingLatest.revision} is withdrawn from approval — its approvers are told — and the new revision starts as a draft.`,
                    confirmLabel: 'Raise new revision',
                    tone: 'primary' as const,
                    onConfirm: raiseRevision,
                  },
                }
              : { label: 'New revision', hint: 'A draft copy of the latest revision, to change and send again', onSelect: () => void raiseRevision().catch(setError) }),
          editable &&
            revision?.costing && {
              label: 'Fill lines from costing',
              hint: `Replace the lines with ${revision.costing.number}'s scope of work`,
              ...(revision.items.length
                ? {
                    confirm: {
                      title: `Replace R${revision.revision}'s lines with ${revision.costing.number}'s scope of work?`,
                      body: `The ${revision.items.length} line${revision.items.length === 1 ? '' : 's'} there now are deleted. The costing is not changed.`,
                      confirmLabel: 'Replace lines',
                      onConfirm: fillFromCosting,
                    },
                  }
                : { onSelect: () => void fillFromCosting().catch(setError) }),
            },
          canMarkLost && {
            label: 'Mark lost',
            danger: true,
            confirm: {
              title: `Mark ${quotation.number} lost?`,
              body: 'Its lead moves with it, so the pipeline stays honest. Sales Analytics reports the reasons.',
              confirmLabel: 'Mark lost',
              reason: 'required' as const,
              reasonLabel: 'Why was it lost?',
              // A quotation lost before and reopened offers the reason it was lost with.
              initialReason: quotation.lostReason ?? '',
              onConfirm: markLost,
            },
          },
          canDelete && {
            label: 'Delete',
            danger: true,
            confirm: {
              title: `Delete ${quotation.number}?`,
              body: 'It cannot be undone. A lead left with no quotation steps back to costing or qualified.',
              confirmLabel: 'Delete',
              onConfirm: remove,
            },
          },
        ]}
        modify={quotation.canEdit ? editHref : undefined}
        confirm={confirm}
      />

      <ErrorBox error={error} />

      {canSubmit &&
        (() => {
          // The route the submit would take — the option's when it is
          // ticked — with who decides each step, named before anybody
          // presses Submit. The submitter is never among them.
          const chosen = chosenOption ? quotation.approvalRoutes?.options.find((o) => o.id === chosenOption)?.route : null;
          const route = chosen ?? quotation.approvalRoutes?.standard;
          const options = quotation.approvalOptions ?? [];
          if (!route?.steps.length && !options.length) return null;
          return (
            <div className="card qd-route sales-card-gap" role="group" aria-label="Submit for approval">
              {options.map((o) => (
                <Checkbox key={o.id} checked={optionId === o.id} onChange={(v) => setOptionId(v ? o.id : null)} label={o.label} />
              ))}
              {!!route?.steps.length && (
                <>
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
                </>
              )}
            </div>
          );
        })()}
      {bookingOrder && <CreateSalesOrderPanel quotation={quotation} onClose={() => setBookingOrder(false)} />}

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

      {/*
        SCORO's "Quote details": the same labels in the same two columns, so a
        salesperson coming from SCORO finds each thing where they left it.
      */}
      <section className="card qd-card" aria-labelledby="qd-title">
        <div className="qd-head">
          <h2 id="qd-title" className="card-title qd-title">
            Quote details
          </h2>
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
              <Detail label="Customer">
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
                {lastMove ? (
                  <StatusBadge status={stageKeyFor(lastMove.from, quotation.quotationStages)} extra={STAGE_TONES} label={stageLabelOf(lastMove.from)} />
                ) : null}
              </Detail>
              <Detail label="Status">
                <span className="qd-status">
                  {/* The STAGE — the word the board and the list use — with the fine step under it. */}
                  <StatusBadge
                    status={quotation.stage || stageKeyFor(quotation.outcome, quotation.quotationStages)}
                    extra={STAGE_TONES}
                    label={quotation.stageLabel ?? stageLabelOf(quotation.outcome)}
                  />
                  <Stamp at={lastMove?.at ?? quotation.createdAt} by={lastMove?.by} />
                </span>
                <div className="qd-sub qd-step">Step: {outcomeLabel(quotation.outcome)}</div>
                {/* SCORO's days-in-status, as one quiet line rather than a row of tiles. */}
                {((quotation.stages?.length ?? 0) > 0 || quotation.closedInDays != null) && (
                  <div className="qd-sub qd-days">
                    {(quotation.stages ?? [])
                      .map((st) => `${stageLabelOf(st.outcome)} ${dayCount(st.days)}${st.current ? ' so far' : ''}`)
                      .join(' · ')}
                    {quotation.closedInDays != null ? ` · ${quotation.outcome === 'WON' ? 'won' : 'lost'} in ${dayCount(quotation.closedInDays)}` : ''}
                  </div>
                )}
                {quotation.canEdit && statusMoves.length > 0 && (
                  <div className="qd-status-change">
                    <select
                      aria-label="Change status"
                      aria-describedby="qd-status-hint"
                      value=""
                      onChange={(e) => changeOutcome(e.target.value)}
                    >
                      <option value="">Change status…</option>
                      {statusMoves.map((o) => {
                        const needsApproval = o.value === 'WON' && !approved;
                        return (
                          <option key={o.value} value={o.value} disabled={needsApproval}>
                            {reopening ? `Reopen — ${o.label}` : o.label}
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

      </section>

      {revision && (
        <>
          {revision.status === 'PENDING_APPROVAL' && (
            <div className="alert info">
              Revision {revision.revision} is with the approver. It cannot be edited until they
              decide — ⋯ › Pull back and edit returns it to draft, or raise a new revision if
              something must change; either way it is withdrawn from their queue.
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
            </div>

            {revision.items.length === 0 ? (
              <Empty
                title="No lines yet"
                hint={
                  !editable
                    ? 'Nothing was quoted on this revision.'
                    : revision.costing
                      ? 'Modify to type the lines in, or ⋯ › Fill lines from costing to bring in the scope sections you already priced.'
                      : 'Modify to type the lines in, or to link a costing and fill them from its scope of work.'
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
                    </tr>
                  </thead>
                  <tbody>
                    {displayRows(revision.items).map((row) =>
                      row.kind === 'heading' ? (
                        <tr key={row.key} className="quote-heading-row">
                          <td />
                          <td colSpan={5 + (showCost ? 2 : 0)}>{row.text}</td>
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
                      </tr>
                      ),
                    )}
                  </tbody>
                </table>
              </div>
            )}

            <div className={`quote-summary${showPanel ? '' : ' quote-summary-single'}`}>
              <TotalsBlock revision={revision} />
              {showPanel && revision.costPanel && <CostPanelBlock panel={revision.costPanel} />}
            </div>
          </div>

          {(can('gops.sales_orders.view_all') || can('gops.sales_orders.view_own')) && (
            <QuotationSalesOrders
              quotationId={quotation.id}
              quotationTotal={Number(valueRevision?.total ?? 0)}
              reloadToken={reload}
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
function QuotationSalesOrders({ quotationId, quotationTotal, reloadToken }: { quotationId: string; quotationTotal: number; reloadToken: number }) {
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
        <Empty title="No sales order yet" hint="Nothing has been booked from this quotation — Create Sales Order, above, books it." />
      ) : (
        <div className="table-wrap">
          <table className="data so-table">
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
      {who && (
        <div className="faint">
          {who.kind} · {who.name}
        </div>
      )}
      {item.costNote && <div className="faint quote-line-desc">{item.costNote}</div>}
    </div>
  );
}

/**
 * SCORO's totals: subtotal, the discount, the sum without tax, the tax and the
 * total. Read only — the discount is changed with the rest of the draft through
 * Modify, where the discount calculator is. The figures are the server's — it
 * recomputes them on every save with the one `quotationTotals`.
 */
function TotalsBlock({ revision }: { revision: Revision }) {
  const rate = `${(revision.vatRate * 100).toFixed(0)}%`;
  return (
    <dl className="quote-totals" aria-label="Totals">
      <div>
        <dt>Subtotal</dt>
        <dd className="mono">{formatMoney(revision.subtotal)}</dd>
      </div>
      <div>
        <dt>{`Discount ${revision.discountPct ? `${revision.discountPct}%` : ''}`}</dt>
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
        {panel.unassignedCost > 0 && row('Unassigned cost', panel.unassignedCost, null)}
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
 * one not yet delivered says "Create project" (in the header) builds it from
 * the approved revision's costing; before that the row says when a project
 * becomes possible — so a won quotation waiting on somebody reads differently
 * from one already delivered.
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
      <span className="faint">Not created yet — Create project, above, builds it</span>
      <div className="qd-sub">
        R{approved.revision} is the approved revision — its costing carries the budget and the schedule of values
        into the project.
      </div>
    </>
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

/**
 * "Create Sales Order", in the page (no dialog): one choice, SCORO's
 * "Transfer all details" (2026-10-07, the owner's call) — the order books
 * what is left of every line of the quotation's VALUE revision, and a second
 * order later books what is left after that. What is left is the server's
 * figure (`/sales-orders/booking`); a line booked in part is adjusted on the
 * order itself, in the editor, and the create route refuses to book what is
 * not there.
 */
function CreateSalesOrderPanel({ quotation, onClose }: { quotation: QuotationDetail; onClose: () => void }) {
  const navigate = useNavigate();
  const toast = useToast();
  const [booking, setBooking] = useState<BookingData | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    let alive = true;
    api
      .get<BookingData>(`/sales-orders/booking${qs({ quotationId: quotation.id })}`)
      .then((b) => alive && setBooking(b))
      .catch((err) => alive && setError(err));
    return () => {
      alive = false;
    };
  }, [quotation.id]);

  async function proceed() {
    setBusy(true);
    setError(null);
    try {
      const made = await api.post<{ id: string; number: string }>('/sales-orders', { quotationId: quotation.id, mode: 'all' });
      toast('ok', `Sales order ${made.number} created`);
      navigate(`/g-ops/sales-orders/${made.id}/edit`);
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  }

  const lines = booking?.lines.filter((l) => !l.isHeading) ?? [];
  const left = lines.filter((l) => l.available > 0);
  const nothingLeft = !!booking && left.length === 0;
  const partial = lines.some((l) => l.booked > 0 && l.available > 0);
  const net = booking?.availableNet ?? 0;
  const total = booking ? (booking.vatInclusive ? net : Math.round(net * (1 + booking.vatRate) * 100) / 100) : 0;

  return (
    <div id="qd-create-so" className="card qd-route so-create sales-card-gap" role="group" aria-label="Create Sales Order">
      <ErrorBox error={error} />
      {!booking && !error && <Loading />}
      {booking && (
        <>
          <p className="qd-route-label">
            Transfer all details: books R{booking.revision}
            {booking.revisionStatus === 'APPROVED' ? '' : ' (no revision is approved yet — the latest is used)'} in operations. A second
            order on this quotation gets a .1, .2 number.
          </p>
          {nothingLeft ? (
            <p>Everything on this quotation is already on a sales order. Cancel an order to give its lines back.</p>
          ) : (
            <dl className="so-sum">
              <div>
                <dt>Lines</dt>
                <dd>
                  {left.length} of {lines.length}
                  {partial ? ' (some in part)' : ''}
                </dd>
              </div>
              <div>
                <dt>Sum without tax</dt>
                <dd className="mono">{formatMoney(net)}</dd>
              </div>
              <div>
                <dt>Total ({booking.vatInclusive ? 'VAT included' : 'with VAT'})</dt>
                <dd className="mono">{formatMoney(total)}</dd>
              </div>
              {booking.bookedNet > 0 && (
                <div>
                  <dt>Already booked</dt>
                  <dd className="mono">{formatMoney(booking.bookedNet)}</dd>
                </div>
              )}
            </dl>
          )}
          <div className="row so-create-actions">
            <button className="btn btn-sm" onClick={onClose} disabled={busy}>
              {nothingLeft ? 'Close' : 'Cancel'}
            </button>
            {!nothingLeft && (
              <button className="btn btn-primary btn-sm" onClick={() => void proceed()} disabled={busy}>
                {busy ? 'Creating…' : 'Proceed'}
              </button>
            )}
          </div>
        </>
      )}
      {!!error && !booking && (
        <button className="btn btn-sm" onClick={onClose}>
          Close
        </button>
      )}
    </div>
  );
}
