import { Prisma } from '@prisma/client';
import { badRequest } from '../http/kit';
import { canEditRecord, type ResolvedUser } from '../permissions/resolve';
import { manilaDayKey, manilaMonthKey } from './day';

/**
 * Pipeline rules shared by the sales board and Insights.
 *
 * One value rule. Insights briefly counted only approved revisions and showed
 * an open quotation as worth nothing while Sales Analytics showed its real
 * value — two screens disagreeing is the bug this file exists to prevent.
 *
 * Everything below is pure: the route fetches, this file decides. That is
 * what lets `verify-sales.ts` prove the move rules and the board arithmetic
 * without an HTTP server, and what keeps the detail pages and the board on
 * ONE set of rules — `PATCH /leads/:id` and `PATCH /quotations/:id` call the
 * same `assert…` functions the board reads its drop targets from.
 */

/**
 * A quotation's value: its APPROVED revision's total, else the total of its
 * highest-numbered revision, else 0.
 *
 * Only one revision may be APPROVED (Phase 3), so "the approved one" is
 * unambiguous. The revisions may arrive in any order — the caller's
 * `orderBy` is not relied on.
 */
export function quotationValue(
  revisions: { status: string; total: Prisma.Decimal | number; revision: number }[],
): number {
  const approved = revisions.find((r) => r.status === 'APPROVED');
  const latest = revisions.reduce<(typeof revisions)[number] | null>(
    (best, r) => (best === null || r.revision > best.revision ? r : best),
    null,
  );
  const chosen = approved ?? latest;
  return chosen ? Number(chosen.total) : 0;
}

// ── Columns ──────────────────────────────────────────────────────────────────

export type ColumnKind = 'lead' | 'quotation' | 'terminal' | 'parked';

export interface BoardColumn {
  key: string;
  label: string;
  kind: ColumnKind;
  /** The lead status a drop on this column writes. */
  leadStatus?: string;
  /** The quotation outcome a drop on this column writes. */
  outcome?: string;
}

/**
 * The board's columns, in order. They ARE the LeadStatus and QuotationOutcome
 * enums — a configuration table that could not rename the enum would be a
 * second truth (Insights funnels and audit summaries speak these names too).
 *
 * A lead stops being a card the moment it has a quotation: from then on its
 * quotation is the card, and the lead's own status is written back from the
 * quotation's outcome. Showing both would count the same deal twice.
 */
export const BOARD_COLUMNS: BoardColumn[] = [
  { key: 'NEW', label: 'New', kind: 'lead', leadStatus: 'NEW' },
  { key: 'CONTACTED', label: 'Contacted', kind: 'lead', leadStatus: 'CONTACTED' },
  { key: 'QUALIFIED', label: 'Qualified', kind: 'lead', leadStatus: 'QUALIFIED' },
  { key: 'SITE_VISIT', label: 'Site visit', kind: 'lead', leadStatus: 'SITE_VISIT' },
  { key: 'COSTING', label: 'Costing', kind: 'lead', leadStatus: 'COSTING' },
  { key: 'QUOTED', label: 'Quotation drafted', kind: 'quotation', outcome: 'OPEN' },
  { key: 'SUBMITTED', label: 'Submitted', kind: 'quotation', outcome: 'SUBMITTED' },
  { key: 'NEGOTIATION', label: 'Negotiation', kind: 'quotation', outcome: 'NEGOTIATION' },
  { key: 'WON', label: 'Won', kind: 'terminal', outcome: 'WON', leadStatus: 'WON' },
  { key: 'LOST', label: 'Lost', kind: 'terminal', outcome: 'LOST', leadStatus: 'LOST' },
  { key: 'ON_HOLD', label: 'On hold', kind: 'parked', leadStatus: 'ON_HOLD' },
];

export const FORECAST_KEY = 'FORECAST';

const LEAD_COLUMN_KEYS = ['NEW', 'CONTACTED', 'QUALIFIED', 'SITE_VISIT', 'COSTING', 'ON_HOLD'];
const QUOTATION_OPEN_KEYS = ['QUOTED', 'SUBMITTED', 'NEGOTIATION'];
/** Lead statuses that mean "its quotation is the card now". */
const LEAD_QUOTATION_STATUSES = ['QUOTATION_CREATED', 'QUOTATION_SUBMITTED', 'NEGOTIATION', 'WON'];

export function columnByKey(key: string): BoardColumn | undefined {
  return BOARD_COLUMNS.find((c) => c.key === key);
}

/**
 * Which column a record stands in, or null when it is not a card at all.
 *
 * A lead with any quotation is never a card (gap 4 of the item 7 design: the
 * lead's estimate AND its quotation's total both landed in Negotiation).
 */
export function columnFor(
  card:
    | { kind: 'lead'; status: string; quotationCount: number }
    | { kind: 'quotation'; outcome: string },
): string | null {
  if (card.kind === 'lead') {
    if (card.quotationCount > 0) return null;
    if (LEAD_QUOTATION_STATUSES.includes(card.status)) return null;
    return LEAD_COLUMN_KEYS.includes(card.status) || card.status === 'LOST' ? card.status : null;
  }
  switch (card.outcome) {
    case 'OPEN':
      return 'QUOTED';
    case 'SUBMITTED':
    case 'NEGOTIATION':
    case 'WON':
    case 'LOST':
      return card.outcome;
    default:
      return null;
  }
}

// ── Move rules ───────────────────────────────────────────────────────────────

export const MSG_LOST_REASON = 'Say why it was lost — Sales Analytics reports the reasons';
export const MSG_QUOTATION_FIRST = 'Raise a quotation from this lead first — a lead is won by its quotation';
export const MSG_APPROVED_REVISION = 'Only an approved revision can be won — submit it for approval first';
export const MSG_NOT_A_LEAD = 'A quotation is not a lead; put its lead on hold from the lead';
export const msgHasJob = (jobNumber: string | null | undefined) =>
  `This quotation became job ${jobNumber ?? ''} — cancel the job before reopening it`.replace('  ', ' ');

/**
 * Where a card may be dropped. LOST is always listed for an open card because
 * it is always legal WITH a reason; the client asks for the reason first.
 */
export function allowedTargets(card: {
  kind: 'lead' | 'quotation';
  column: string;
  hasApprovedRevision?: boolean;
  hasJob?: boolean;
}): string[] {
  if (card.kind === 'lead') {
    return [...LEAD_COLUMN_KEYS, 'LOST'].filter((k) => k !== card.column);
  }
  if (card.column === 'WON' && card.hasJob) return [];
  const targets = [...QUOTATION_OPEN_KEYS];
  if (card.hasApprovedRevision) targets.push('WON');
  targets.push('LOST');
  return targets.filter((k) => k !== card.column);
}

/**
 * The lead's move rules. Thrown as a 400 with the message the UI shows.
 *
 * A lead can wander freely between its own stages and be parked or lost; it
 * cannot be quoted, negotiated or won by hand, because those states are
 * written by its quotation and a lead with no quotation has nothing to win.
 */
export function assertLeadStatusChange(
  before: string,
  next: string,
  ctx: { lostReason?: string | null; hasQuotations: boolean },
): void {
  if (before === next) return;
  if (next === 'LOST' && !(ctx.lostReason ?? '').trim()) throw badRequest(MSG_LOST_REASON);
  if (LEAD_QUOTATION_STATUSES.includes(next) && !ctx.hasQuotations) throw badRequest(MSG_QUOTATION_FIRST);
}

/**
 * The quotation's move rules. WON needs an approved revision (model §4.1:
 * only the approved revision converts to a job); LOST needs a reason; a
 * quotation that already became a job cannot leave WON.
 */
export function assertOutcomeChange(
  before: string,
  next: string,
  ctx: { lostReason?: string | null; hasApprovedRevision: boolean; hasJob: boolean; jobNumber?: string | null },
): void {
  if (before === next) return;
  if (before === 'WON' && ctx.hasJob) throw badRequest(msgHasJob(ctx.jobNumber));
  if (next === 'WON' && !ctx.hasApprovedRevision) throw badRequest(MSG_APPROVED_REVISION);
  if (next === 'LOST' && !(ctx.lostReason ?? '').trim()) throw badRequest(MSG_LOST_REASON);
}

// ── Outcome history (SCORO's "Previous status" and "Opportunity 46 days") ────

/** One move of a quotation's outcome: from what, to what, when, and by whom. */
export interface OutcomeChange {
  from: string;
  to: string;
  at: Date;
  by: { id: string | null; name: string } | null;
}

const OUTCOME_KEYS = new Set(['OPEN', 'SUBMITTED', 'NEGOTIATION', 'WON', 'LOST']);
/** "Quotation 0012609061: OPEN → SUBMITTED", as PATCH /quotations/:id has always summarised a move. */
const SUMMARY_MOVE = /: ([A-Z_]+) → ([A-Z_]+)$/;

/**
 * A quotation's outcome moves, oldest first, read off its audit rows — the
 * record every move already writes. There is no history table: the audit trail
 * IS the history, and a second copy could disagree with it. A move carries its
 * two outcomes in `before`/`after`; rows written before it did carry them only
 * in the summary, which is read when `before`/`after` say nothing.
 */
export function outcomeChanges(
  rows: {
    summary: string | null;
    before: unknown;
    after: unknown;
    at: Date;
    actorId: string | null;
    actorName: string | null;
  }[],
): OutcomeChange[] {
  const out: OutcomeChange[] = [];
  for (const row of [...rows].sort((a, b) => a.at.getTime() - b.at.getTime())) {
    const was = (row.before ?? null) as { outcome?: unknown } | null;
    const now = (row.after ?? null) as { outcome?: unknown } | null;
    let from = typeof was?.outcome === 'string' ? was.outcome : null;
    let to = typeof now?.outcome === 'string' ? now.outcome : null;
    if (!from || !to) {
      const m = SUMMARY_MOVE.exec(row.summary ?? '');
      if (m) [from, to] = [m[1], m[2]];
    }
    if (!from || !to || from === to || !OUTCOME_KEYS.has(from) || !OUTCOME_KEYS.has(to)) continue;
    out.push({ from, to, at: row.at, by: row.actorName ? { id: row.actorId, name: row.actorName } : null });
  }
  return out;
}

/** Whole Manila calendar days from one instant's day to another's: 3 Jan to 18 Feb is 46. */
export function manilaDaysBetween(from: Date, to: Date): number {
  const a = Date.parse(`${manilaDayKey(from)}T00:00:00Z`);
  const b = Date.parse(`${manilaDayKey(to)}T00:00:00Z`);
  return Math.round((b - a) / 86_400_000);
}

export interface OutcomeStage {
  outcome: string;
  days: number;
  /** The stretch still running — the quotation is in this outcome now. */
  current: boolean;
}

/**
 * How long a quotation spent in each outcome, as SCORO's strip shows it —
 * "Opportunity 46 days | Closed in 65 days" — in Manila calendar days, in the
 * order the outcomes were first reached. An outcome returned to (NEGOTIATION,
 * reopened) adds to its own total rather than appearing twice.
 *
 * A decided quotation (WON or LOST) lists the stretches that led there and
 * `closedInDays`, issue to decision; "Won for 12 days" would say nothing. The
 * decision's date is `decidedAt` where the quotation has one, else the move
 * that decided it.
 */
export function outcomeStages(
  createdAt: Date,
  current: string,
  changes: OutcomeChange[],
  decidedAt: Date | null,
  now: Date,
): { stages: OutcomeStage[]; closedInDays: number | null } {
  const order: string[] = [];
  const total = new Map<string, number>();
  const add = (outcome: string, days: number) => {
    if (!total.has(outcome)) order.push(outcome);
    total.set(outcome, (total.get(outcome) ?? 0) + Math.max(0, days));
  };

  let outcome = changes[0]?.from ?? current;
  let since = createdAt;
  for (const c of changes) {
    add(outcome, manilaDaysBetween(since, c.at));
    outcome = c.to;
    since = c.at;
  }
  const decided = current === 'WON' || current === 'LOST';
  if (!decided) add(current, manilaDaysBetween(since, now));

  const decision = decidedAt ?? (decided && changes.length ? since : null);
  return {
    stages: order.map((o) => ({ outcome: o, days: total.get(o)!, current: !decided && o === current })),
    closedInDays: decided && decision ? Math.max(0, manilaDaysBetween(createdAt, decision)) : null,
  };
}

// ── Dates ────────────────────────────────────────────────────────────────────

/**
 * Is this closing date in the current month — the company's month, in Manila,
 * whatever the host clock says. `expectedClosing` is a @db.Date, stored as
 * UTC midnight; in Manila that is 08:00 the same day, so the key is honest.
 */
export function inForecastMonth(expectedClosing: Date | null | undefined, now: Date): boolean {
  if (!expectedClosing) return false;
  return manilaMonthKey(expectedClosing) === manilaMonthKey(now);
}

export interface OverdueInput {
  kind: 'lead' | 'quotation';
  expectedClosing?: Date | null;
  nextActionDate?: Date | null;
  submittedAt?: Date | null;
  latestRevisionAt?: Date | null;
  validityDays?: number | null;
}

/**
 * An OPEN card that is past something: its expected close, a lead's next
 * action date, or a quotation's validity (`submittedAt ?? latest revision
 * date` + validityDays). Day comparisons are on Manila day keys so a card is
 * not overdue at 23:30 the night before.
 */
export function isOverdue(card: OverdueInput, now: Date): boolean {
  const today = manilaDayKey(now);
  if (card.expectedClosing && manilaDayKey(card.expectedClosing) < today) return true;
  if (card.kind === 'lead') {
    return !!card.nextActionDate && manilaDayKey(card.nextActionDate) < today;
  }
  const from = card.submittedAt ?? card.latestRevisionAt ?? null;
  if (from && card.validityDays) {
    const lapses = new Date(from.getTime() + card.validityDays * 86_400_000);
    return manilaDayKey(lapses) < today;
  }
  return false;
}

// ── The board ────────────────────────────────────────────────────────────────

export interface BoardPerson {
  id: string;
  name: string;
  photoPath: string | null;
}

export interface BoardLead {
  id: string;
  number: string;
  companyName: string;
  description: string | null;
  status: string;
  estimatedValue: Prisma.Decimal | number | null;
  probability: number;
  expectedClosing: Date | null;
  nextAction: string | null;
  nextActionDate: Date | null;
  lostReason: string | null;
  createdAt: Date;
  updatedAt: Date;
  assignedToId: string;
  assignedTo: BoardPerson;
  customer: { id: string; name: string } | null;
  /** The next PLANNED activity, if any — the route fetches `take: 1`. */
  activities: { subject: string; startsAt: Date }[];
  quotationCount: number;
}

export interface BoardRevision {
  id: string;
  revision: number;
  status: string;
  total: Prisma.Decimal | number;
  validityDays: number;
  createdAt: Date;
  costing: {
    contractValue: Prisma.Decimal | number;
    totalCost: Prisma.Decimal | number;
    markupPct: Prisma.Decimal | number;
    discountAmount: Prisma.Decimal | number;
  } | null;
  jobs: { id: string; number: string }[];
}

export interface BoardQuotation {
  id: string;
  number: string;
  subject: string;
  outcome: string;
  probability: number;
  submittedAt: Date | null;
  decidedAt: Date | null;
  lostReason: string | null;
  expectedClosing: Date | null;
  createdAt: Date;
  ownerId: string;
  owner: BoardPerson;
  customer: { id: string; name: string };
  lead: { expectedClosing: Date | null; nextAction: string | null; nextActionDate: Date | null } | null;
  revisions: BoardRevision[];
  activities: { subject: string; startsAt: Date }[];
}

export interface Card {
  ref: string;
  kind: 'lead' | 'quotation';
  id: string;
  number: string;
  /** The customer's name (companyName for an unlinked lead). */
  title: string;
  subject: string | null;
  customer: { id: string; name: string } | null;
  owner: BoardPerson;
  value: number;
  probability: number;
  weighted: number;
  ageDays: number;
  expectedClosing: string | null;
  nextStep: { label: string; at: string | null } | null;
  revision: { n: number; status: string } | null;
  hasApprovedRevision: boolean;
  job: { id: string; number: string } | null;
  lostReason: string | null;
  overdue: boolean;
  canMove: boolean;
  allowedTargets: string[];
  link: string;
  column: string;
}

export interface BoardColumnOut {
  key: string;
  label: string;
  kind: ColumnKind;
  count: number;
  value: number;
  weighted: number;
  cards: Card[];
}

export interface BoardKpis {
  openQuotes: number;
  quotedValue: number;
  weightedValue: number;
  leadEstimate: number;
  leadCount: number;
  averageQuote: number | null;
  averageDiscountPct: number | null;
  expectedMarginPct: number | null;
  marginSample: { withCosting: number; open: number };
  overdue: number;
  wonCount: number;
  wonValue: number;
  lostCount: number;
  lostValue: number;
  forecastValue: number;
  forecastWeighted: number;
  forecastCount: number;
  unprobabled: number;
}

export interface BoardResponse {
  asOf: string;
  window: { decidedFrom: string; decidedWithinDays: number };
  kpis: BoardKpis;
  columns: BoardColumnOut[];
  forecast: { key: string; label: string; count: number; value: number; weighted: number; cards: Card[] };
  people: BoardPerson[];
}

const cents = (n: number) => Math.round(n * 100) / 100;
const num = (v: Prisma.Decimal | number | null | undefined) => (v == null ? 0 : Number(v));
const isoDay = (d: Date | null | undefined) => (d ? d.toISOString().slice(0, 10) : null);
const daysBetween = (from: Date, to: Date) => Math.max(0, Math.round((to.getTime() - from.getTime()) / 86_400_000));

/**
 * Σ value × probability, rounded ONCE at the end — the way Insights sums it.
 * Summing the per-card rounded figures drifts a centavo from Sales Analytics
 * on a big enough board, and the two are asserted equal to the centavo.
 */
const weightedSum = (cards: Card[]) => cents(cards.reduce((s, c) => s + (c.value * c.probability) / 100, 0));

/** The revision the card is valued at — the same choice `quotationValue` makes. */
function valuedRevision(revisions: BoardRevision[]): BoardRevision | null {
  const approved = revisions.find((r) => r.status === 'APPROVED');
  if (approved) return approved;
  return revisions.reduce<BoardRevision | null>(
    (best, r) => (best === null || r.revision > best.revision ? r : best),
    null,
  );
}

function leadCard(lead: BoardLead, now: Date, me: ResolvedUser): Card | null {
  const column = columnFor({ kind: 'lead', status: lead.status, quotationCount: lead.quotationCount });
  if (!column) return null;
  const value = num(lead.estimatedValue);
  const probability = column === 'LOST' ? 0 : lead.probability;
  const planned = lead.activities[0];
  const canMove = canEditRecord(me, 'gops', 'leads', lead.assignedToId);
  return {
    ref: `lead:${lead.id}`,
    kind: 'lead',
    id: lead.id,
    number: lead.number,
    title: lead.customer?.name ?? lead.companyName,
    subject: lead.description ? lead.description.split('\n')[0].trim() || null : null,
    customer: lead.customer,
    owner: lead.assignedTo,
    value: cents(value),
    probability,
    weighted: cents((value * probability) / 100),
    ageDays: daysBetween(lead.createdAt, now),
    expectedClosing: isoDay(lead.expectedClosing),
    nextStep: planned
      ? { label: planned.subject, at: planned.startsAt.toISOString() }
      : lead.nextAction
        ? { label: lead.nextAction, at: lead.nextActionDate ? lead.nextActionDate.toISOString() : null }
        : null,
    revision: null,
    hasApprovedRevision: false,
    job: null,
    lostReason: lead.lostReason,
    overdue:
      column === 'LOST' || column === 'ON_HOLD'
        ? false
        : isOverdue({ kind: 'lead', expectedClosing: lead.expectedClosing, nextActionDate: lead.nextActionDate }, now),
    canMove,
    allowedTargets: canMove ? allowedTargets({ kind: 'lead', column }) : [],
    link: `/g-ops/leads/${lead.id}`,
    column,
  };
}

function quotationCard(q: BoardQuotation, now: Date, me: ResolvedUser): Card | null {
  const column = columnFor({ kind: 'quotation', outcome: q.outcome });
  if (!column) return null;
  const value = quotationValue(q.revisions);
  const rev = valuedRevision(q.revisions);
  const latest = q.revisions.reduce<BoardRevision | null>(
    (best, r) => (best === null || r.revision > best.revision ? r : best),
    null,
  );
  const hasApprovedRevision = q.revisions.some((r) => r.status === 'APPROVED');
  const job = q.revisions.flatMap((r) => r.jobs)[0] ?? null;
  const probability = column === 'WON' ? 100 : column === 'LOST' ? 0 : q.probability;
  const planned = q.activities[0];
  const expectedClosing = q.expectedClosing ?? q.lead?.expectedClosing ?? null;
  const open = QUOTATION_OPEN_KEYS.includes(column);
  const canMove = canEditRecord(me, 'gops', 'quotations', q.ownerId);
  return {
    ref: `quotation:${q.id}`,
    kind: 'quotation',
    id: q.id,
    number: q.number,
    title: q.customer.name,
    subject: q.subject,
    customer: q.customer,
    owner: q.owner,
    value: cents(value),
    probability,
    weighted: cents((value * probability) / 100),
    ageDays: daysBetween(q.submittedAt ?? q.createdAt, now),
    expectedClosing: isoDay(expectedClosing),
    nextStep: planned
      ? { label: planned.subject, at: planned.startsAt.toISOString() }
      : q.lead?.nextAction
        ? { label: q.lead.nextAction, at: q.lead.nextActionDate ? q.lead.nextActionDate.toISOString() : null }
        : null,
    revision: rev ? { n: rev.revision, status: rev.status } : null,
    hasApprovedRevision,
    job,
    lostReason: q.lostReason,
    overdue: open
      ? isOverdue(
          {
            kind: 'quotation',
            expectedClosing,
            submittedAt: q.submittedAt,
            latestRevisionAt: latest?.createdAt ?? q.createdAt,
            validityDays: rev?.validityDays ?? latest?.validityDays ?? null,
          },
          now,
        )
      : false,
    canMove,
    allowedTargets: canMove ? allowedTargets({ kind: 'quotation', column, hasApprovedRevision, hasJob: !!job }) : [],
    link: `/g-ops/quotations/${q.id}`,
    column,
  };
}

/**
 * The whole board as a pure function of what was fetched.
 *
 * Won and Lost are bounded by `decidedWithinDays` HERE as well as in the
 * route's query, so a caller that fetched more than the window (a test, say)
 * still gets a bounded board. Quoted figures and lead estimates are kept
 * apart: `quotedValue` must reconcile to Insights' `openValue`, and adding a
 * lead's guess to a quotation's price would break that in both directions.
 */
export function buildBoard(input: {
  leads: BoardLead[];
  quotations: BoardQuotation[];
  now: Date;
  decidedWithinDays: number;
  me: ResolvedUser;
}): BoardResponse {
  const { now, me } = input;
  const decidedFrom = new Date(now.getTime() - input.decidedWithinDays * 86_400_000);

  const cards: Card[] = [];
  for (const lead of input.leads) {
    if (lead.status === 'LOST' && lead.updatedAt < decidedFrom) continue;
    const c = leadCard(lead, now, me);
    if (c) cards.push(c);
  }
  const quotationById = new Map<string, BoardQuotation>();
  for (const q of input.quotations) {
    if ((q.outcome === 'WON' || q.outcome === 'LOST') && (!q.decidedAt || q.decidedAt < decidedFrom)) continue;
    const c = quotationCard(q, now, me);
    if (c) {
      cards.push(c);
      quotationById.set(q.id, q);
    }
  }

  const columns: BoardColumnOut[] = BOARD_COLUMNS.map((col) => {
    const mine = cards.filter((c) => c.column === col.key);
    return {
      key: col.key,
      label: col.label,
      kind: col.kind,
      count: mine.length,
      value: cents(mine.reduce((s, c) => s + c.value, 0)),
      weighted: weightedSum(mine),
      cards: mine,
    };
  });

  const openQuotationCards = cards.filter((c) => c.kind === 'quotation' && QUOTATION_OPEN_KEYS.includes(c.column));
  const leadCards = cards.filter((c) => c.kind === 'lead' && c.column !== 'LOST');
  const openCards = [...leadCards.filter((c) => c.column !== 'ON_HOLD'), ...openQuotationCards];

  const quotedValue = cents(openQuotationCards.reduce((s, c) => s + c.value, 0));
  const weightedValue = weightedSum(openQuotationCards);

  // Margin and discount come from the costing behind the VALUED revision.
  let contract = 0;
  let cost = 0;
  let withCosting = 0;
  const discounts: number[] = [];
  for (const c of openQuotationCards) {
    const q = quotationById.get(c.id);
    const rev = q ? valuedRevision(q.revisions) : null;
    if (!rev?.costing) continue;
    withCosting++;
    contract += num(rev.costing.contractValue);
    cost += num(rev.costing.totalCost);
    const listPrice = num(rev.costing.totalCost) * (1 + num(rev.costing.markupPct));
    if (listPrice > 0) discounts.push(num(rev.costing.discountAmount) / listPrice);
  }

  const won = cards.filter((c) => c.column === 'WON');
  const lost = cards.filter((c) => c.column === 'LOST');

  const forecastCards = openCards.filter((c) => c.expectedClosing && inForecastMonth(new Date(c.expectedClosing), now));
  const forecastValue = cents(forecastCards.reduce((s, c) => s + c.value, 0));
  const forecastWeighted = weightedSum(forecastCards);

  const people = new Map<string, BoardPerson>();
  for (const c of cards) people.set(c.owner.id, c.owner);

  return {
    asOf: now.toISOString(),
    window: { decidedFrom: decidedFrom.toISOString(), decidedWithinDays: input.decidedWithinDays },
    kpis: {
      openQuotes: openQuotationCards.length,
      quotedValue,
      weightedValue,
      leadEstimate: cents(leadCards.reduce((s, c) => s + c.value, 0)),
      leadCount: leadCards.length,
      averageQuote: openQuotationCards.length ? cents(quotedValue / openQuotationCards.length) : null,
      averageDiscountPct: discounts.length
        ? Math.round((discounts.reduce((a, b) => a + b, 0) / discounts.length) * 1000) / 10
        : null,
      expectedMarginPct: withCosting && contract > 0 ? Math.round(((contract - cost) / contract) * 1000) / 10 : null,
      marginSample: { withCosting, open: openQuotationCards.length },
      overdue: openCards.filter((c) => c.overdue).length,
      wonCount: won.length,
      wonValue: cents(won.reduce((s, c) => s + c.value, 0)),
      lostCount: lost.length,
      lostValue: cents(lost.reduce((s, c) => s + c.value, 0)),
      forecastValue,
      forecastWeighted,
      forecastCount: forecastCards.length,
      unprobabled: forecastCards.filter((c) => c.probability === 0).length,
    },
    columns,
    forecast: {
      key: FORECAST_KEY,
      label: 'This month forecast',
      count: forecastCards.length,
      value: forecastValue,
      weighted: forecastWeighted,
      cards: forecastCards,
    },
    people: [...people.values()].sort((a, b) => a.name.localeCompare(b.name)),
  };
}
