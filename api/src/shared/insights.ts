import { Prisma } from '@prisma/client';
import { prisma } from '../prisma';
import { badRequest } from '../http/kit';
import type { ResolvedUser } from '../permissions/resolve';
import { gopsOverview } from './gops';
import { chainOverview } from './chain';
import { attendanceDay, dayKey as hrDayKey } from './hr';
import { financePosition } from './finance';
import { manilaDate, manilaDayEnd, manilaDayStart, manilaMonthKey } from './day';

/**
 * The reporting layer.
 *
 * Phase 9 adds **no tables**. Every figure it shows is read off documents the
 * first eight phases already record, which is the only way a management report
 * can never disagree with the records behind it. Where a number here differs
 * from a number on a project screen, this module is wrong.
 *
 * Two rules follow from that, and they are worth holding on to:
 *
 *   · **No number without a source.** Every row carries the id of the record it
 *     came from, so a director who does not believe a figure can click through
 *     to the document that produced it.
 *   · **Say when a number is not yet meaningful.** Margin on a project that has
 *     spent nothing is 100%, which is true and useless. A report that presents
 *     it without saying so is worse than one that omits it.
 */

export const cents = (n: number) => Math.round(n * 100) / 100;
export const num = (v: Prisma.Decimal | null | undefined) => (v == null ? 0 : Number(v));
export const pct = (part: number, whole: number) => (whole > 0 ? cents((part / whole) * 100) : 0);

/**
 * The Manila date as UTC midnight — the same rule as G-FIN's `dayKey`, which
 * the overview's position is read through. Before 08:00 the UTC date is still
 * yesterday's: "this month" on the 1st meant last month.
 */
export const dayKey = (at: Date): Date => manilaDate(at);

/**
 * The Manila month a date or an instant falls in. A stored DATE (UTC midnight,
 * 08:00 in Manila) keeps its own month; an instant from the first eight hours
 * of the 1st no longer lands in the month before.
 */
export function monthKey(d: Date): string {
  return manilaMonthKey(d);
}

/** A list of month keys, oldest first, ending with the Manila month `to` falls in. */
export function monthsBack(count: number, to = new Date()): string[] {
  const day = dayKey(to);
  const out: string[] = [];
  for (let i = count - 1; i >= 0; i--) {
    out.push(monthKey(new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth() - i, 1))));
  }
  return out;
}

export interface Range {
  /** The first day, for a DATE column: UTC midnight, which a DATE reads as that day. */
  from: Date;
  /** The last day, for a DATE column: 23:59:59.999Z, still that day. */
  to: Date;
  /** Manila midnight of the first day, for a TIMESTAMP column. */
  fromAt: Date;
  /** The last instant of the last day in Manila, for a TIMESTAMP column. */
  toAt: Date;
}

/**
 * The window a report covers, as Manila's days.
 *
 * Defaults to the current year rather than "everything", because a report over
 * all of history answers a different question than the one anybody asked.
 *
 * Two pairs of edges, one per kind of column. `from`/`to` are for `@db.Date`
 * columns (`billingDate`, `clearedAt`), which Prisma binds as their UTC date.
 * `fromAt`/`toAt` are for TIMESTAMPS (`decidedAt`, `createdAt`): Manila
 * midnight to 23:59:59.999 in Manila. Using `from`/`to` on a timestamp made the
 * day run from 08:00 to 08:00, so a quotation won at 07:00 on the 1st counted
 * in the month before. Ending at midnight, before that, dropped the last day.
 */
export function parseRange(fromRaw?: string, toRaw?: string): Range {
  const now = new Date();
  const from = fromRaw ? new Date(fromRaw) : new Date(Date.UTC(dayKey(now).getUTCFullYear(), 0, 1));
  const to = toRaw ? new Date(toRaw) : now;
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
    throw badRequest('That is not a valid date range');
  }
  if (to < from) throw badRequest('The range ends before it starts');
  const first = dayKey(from);
  const last = dayKey(to);
  return {
    from: first,
    to: new Date(last.getTime() + 86_399_999),
    fromAt: manilaDayStart(first.toISOString().slice(0, 10)),
    toAt: manilaDayEnd(last.toISOString().slice(0, 10)),
  };
}

// ── Project profitability ────────────────────────────────────────────────────

export interface ProjectProfit {
  job: { id: string; number: string; name: string; status: string; type: string };
  customer: { id: string; name: string };
  projectManager: string | null;
  contractValue: number;
  budgetedCost: number;
  /** Committed + incurred: what is spent or promised. */
  actualCost: number;
  committed: number;
  incurred: number;
  available: number;
  billed: number;
  collected: number;
  /** Contract value − budgeted cost. What the job was sold to make. */
  expectedProfit: number;
  expectedMarginPct: number;
  /** Contract value − actual cost. Only meaningful near completion. */
  runningProfit: number;
  runningMarginPct: number;
  /** How far the money says the job has gone: actual cost over budget. */
  costUsedPct: number;
  /** Billed over contract value. */
  billedPct: number;
  /** True while too little has been spent for the running margin to mean anything. */
  tooEarly: boolean;
  /** Spending faster than billing, by more than a tenth of the contract. */
  overspending: boolean;
  startDate: Date | null;
  actualEndDate: Date | null;
}

/**
 * Profit per job, from the cost ledger and the billings.
 *
 * `tooEarly` is the honest part. A job that has spent 2% of its budget shows a
 * running margin close to 100%, which is arithmetically correct and completely
 * misleading — so it is flagged, and the screens lead with EXPECTED margin,
 * which comes from the budget and means something on day one.
 */
export async function projectProfitability(opts: {
  type?: 'PROJECT' | 'SERVICE_CONTRACT';
  status?: string;
  customerId?: string;
  range?: Range;
}): Promise<ProjectProfit[]> {
  const where: Prisma.JobWhereInput = { status: { notIn: ['CANCELLED'] } };
  if (opts.type) where.type = opts.type;
  if (opts.status) where.status = opts.status as Prisma.EnumJobStatusFilter['equals'];
  if (opts.customerId) where.customerId = opts.customerId;
  if (opts.range) where.createdAt = { gte: opts.range.fromAt, lte: opts.range.toAt };

  const jobs = await prisma.job.findMany({
    where,
    select: {
      id: true,
      number: true,
      name: true,
      status: true,
      type: true,
      contractValue: true,
      startDate: true,
      actualEndDate: true,
      customer: { select: { id: true, name: true } },
      projectManager: { select: { name: true } },
    },
    orderBy: { createdAt: 'desc' },
    take: 500,
  });
  if (!jobs.length) return [];

  const ids = jobs.map((j) => j.id);
  // Three grouped queries rather than three per job: a hundred projects would
  // otherwise be three hundred round trips.
  const [ledger, billings, invoices] = await Promise.all([
    prisma.jobCostEntry.groupBy({
      by: ['jobId', 'state'],
      where: { jobId: { in: ids } },
      _sum: { amount: true },
    }),
    prisma.progressBilling.groupBy({
      by: ['jobId'],
      where: { jobId: { in: ids }, status: { in: ['APPROVED', 'INVOICED'] } },
      _sum: { grossAmount: true },
    }),
    prisma.invoice.groupBy({
      by: ['jobId'],
      where: { jobId: { in: ids }, status: { not: 'CANCELLED' } },
      _sum: { amountCollected: true },
    }),
  ]);

  const state = (jobId: string, s: string) =>
    num(ledger.find((l) => l.jobId === jobId && l.state === s)?._sum.amount);

  return jobs.map((job) => {
    const contractValue = num(job.contractValue);
    const budgetedCost = state(job.id, 'BUDGETED');
    const committed = state(job.id, 'COMMITTED');
    const incurred = state(job.id, 'INCURRED');
    const actualCost = cents(committed + incurred);
    const billed = num(billings.find((b) => b.jobId === job.id)?._sum.grossAmount);
    const collected = num(invoices.find((i) => i.jobId === job.id)?._sum.amountCollected);

    const costUsedPct = pct(actualCost, budgetedCost);
    const billedPct = pct(billed, contractValue);

    return {
      job: { id: job.id, number: job.number, name: job.name, status: job.status, type: job.type },
      customer: job.customer,
      projectManager: job.projectManager?.name ?? null,
      contractValue,
      budgetedCost,
      actualCost,
      committed,
      incurred,
      // Available = budgeted − committed − incurred. CONSUMED is never
      // subtracted: it was already counted as incurred when received.
      available: cents(budgetedCost - committed - incurred),
      billed,
      collected,
      expectedProfit: cents(contractValue - budgetedCost),
      expectedMarginPct: pct(contractValue - budgetedCost, contractValue),
      runningProfit: cents(contractValue - actualCost),
      runningMarginPct: pct(contractValue - actualCost, contractValue),
      costUsedPct,
      billedPct,
      tooEarly: costUsedPct < 20,
      // The early warning that matters: cost running ahead of billing means
      // the job is funding itself out of the company's cash.
      overspending: costUsedPct - billedPct > 10 && costUsedPct >= 20,
      startDate: job.startDate,
      actualEndDate: job.actualEndDate,
    };
  });
}

// ── Sales pipeline ───────────────────────────────────────────────────────────

export interface PipelineStage {
  stage: string;
  count: number;
  value: number;
}

export interface SalesPerson {
  id: string;
  name: string;
  leads: number;
  quotations: number;
  quotedValue: number;
  won: number;
  wonValue: number;
  lost: number;
  /** Won as a share of everything decided — a quotation still open is neither. */
  winRatePct: number;
  /** Median days from quotation to a decision, where there is one. */
  medianDaysToDecide: number | null;
}

export function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

// ── Inventory ────────────────────────────────────────────────────────────────

export interface SlowMover {
  item: { id: string; code: string; name: string; unit: string };
  quantity: number;
  averageCost: number;
  value: number;
  lastMovedAt: Date | null;
  daysSinceMoved: number | null;
}

/**
 * Stock that has not moved, ranked by what it is worth.
 *
 * Ranked by VALUE rather than by age on purpose: a thousand cheap washers
 * sitting for two years matter less than one compressor sitting for six months,
 * and a report sorted by age puts the washers at the top.
 */
export async function slowMovers(sinceDays: number): Promise<SlowMover[]> {
  const cutoff = dayKey(new Date());
  cutoff.setUTCDate(cutoff.getUTCDate() - sinceDays);

  const balances = await prisma.inventoryBalance.findMany({
    where: { quantity: { gt: 0 } },
    include: { item: { select: { id: true, code: true, name: true, unit: true } } },
  });
  if (!balances.length) return [];

  const itemIds = [...new Set(balances.map((b) => b.itemId))];
  const lastMoves = await prisma.inventoryTransaction.groupBy({
    by: ['itemId'],
    where: { itemId: { in: itemIds } },
    _max: { occurredAt: true },
  });
  const lastBy = new Map(lastMoves.map((m) => [m.itemId, m._max.occurredAt]));

  const today = dayKey(new Date());
  const rows: SlowMover[] = [];
  const byItem = new Map<string, SlowMover>();

  for (const b of balances) {
    const lastMovedAt = lastBy.get(b.itemId) ?? null;
    if (lastMovedAt && lastMovedAt >= cutoff) continue;

    const quantity = num(b.quantity);
    const averageCost = num(b.averageCost);
    // One item can sit in several warehouses; the question is how much of it
    // there is in total, not how much in each shed.
    const existing = byItem.get(b.itemId);
    if (existing) {
      existing.quantity = cents(existing.quantity + quantity);
      existing.value = cents(existing.value + quantity * averageCost);
      continue;
    }
    const row: SlowMover = {
      item: b.item,
      quantity,
      averageCost,
      value: cents(quantity * averageCost),
      lastMovedAt,
      daysSinceMoved: lastMovedAt
        ? Math.floor((today.getTime() - dayKey(lastMovedAt).getTime()) / 86_400_000)
        : null,
    };
    byItem.set(b.itemId, row);
    rows.push(row);
  }

  return rows.sort((a, b) => b.value - a.value);
}

// ── Cash forecast ────────────────────────────────────────────────────────────

export interface ForecastBucket {
  label: string;
  /** Start of the window, in days from today. Negative means overdue. */
  fromDay: number;
  toDay: number | null;
  invoiced: number;
  /** Work done and approved but not yet invoiced — cash a decision away. */
  unbilled: number;
  /** Unspent advance money a person owes back — cash in, never a collection. */
  refunds: number;
  payable: number;
  reimbursable: number;
  committed: number;
  /** Approved cash advances finance has not yet handed over — cash promised. */
  advances: number;
  /** invoiced + unbilled + refunds − payable − reimbursable − committed − advances */
  net: number;
}

export const FORECAST_WINDOWS: { label: string; from: number; to: number }[] = [
  { label: 'Overdue', from: Number.NEGATIVE_INFINITY, to: -1 },
  { label: 'Next 7 days', from: 0, to: 7 },
  { label: '8–30 days', from: 8, to: 30 },
  { label: '31–60 days', from: 31, to: 60 },
  { label: '61–90 days', from: 61, to: 90 },
  { label: 'Beyond 90 days', from: 91, to: Number.POSITIVE_INFINITY },
];

export function windowFor(days: number): number {
  return FORECAST_WINDOWS.findIndex((w) => days >= w.from && days <= w.to);
}

// ── Approval bottleneck ──────────────────────────────────────────────────────

export interface BottleneckRow {
  id: string;
  documentType: string;
  documentNumber: string | null;
  subject: string;
  amount: number | null;
  requester: string;
  waitingOn: string;
  step: string;
  waitingDays: number;
  /** The document itself (`ApprovalRequest.link`), so a stuck row opens. */
  link: string | null;
}

/**
 * Every document waiting on an approval, oldest first, with who holds it.
 *
 * One reader for the Performance screen and its CSV twin, so the two cannot
 * name a different approver for the same document.
 */
export async function approvalBottleneck(now = Date.now()): Promise<BottleneckRow[]> {
  const pending = await prisma.approvalRequest.findMany({
    where: { status: 'PENDING' },
    select: {
      id: true,
      documentType: true,
      documentNumber: true,
      subject: true,
      amount: true,
      link: true,
      createdAt: true,
      currentSequence: true,
      requester: { select: { name: true } },
      workflow: { select: { name: true, steps: { include: { role: true, user: true } } } },
    },
    orderBy: { createdAt: 'asc' },
  });
  return pending.map((p) => {
    const step = p.workflow?.steps.find((s) => s.sequence === p.currentSequence);
    return {
      id: p.id,
      documentType: p.documentType,
      documentNumber: p.documentNumber,
      subject: p.subject,
      amount: p.amount ? num(p.amount) : null,
      requester: p.requester.name,
      waitingOn: step?.user?.name ?? step?.role?.name ?? step?.approverType.toLowerCase() ?? 'nobody',
      step: step?.name ?? `Step ${p.currentSequence}`,
      waitingDays: Math.floor((now - p.createdAt.getTime()) / 86_400_000),
      link: p.link,
    };
  });
}

// ── The company at a glance ──────────────────────────────────────────────────

/**
 * One line per division, each reconciled to that division's OWN dashboard.
 *
 * Every figure is read through the function that module's dashboard itself
 * calls — `gopsOverview`, `chainOverview`, `attendanceDay`, `financePosition`
 * — so the brief cannot disagree with the screen a figure links to. Where it
 * does, the shared function is what changes; never a copy here.
 *
 * Who sees a line is that module's `*.dashboard.view_all`, decided here on
 * the server. A figure the caller may not see is OMITTED, never sent as 0:
 * a zero that is really "not yours to know" reads as an empty queue.
 *
 * Every day on this panel is Manila's, each read the way its own module reads
 * it: G-OPS ranges through `periodWhere`, G-FIN and G-CHAIN through `dayKey`
 * (`manilaDate`) and `parseRange`, and the G-HR day through HR's local
 * `dayKey` — the server clock, which is Manila's on the server. The screen's
 * caption says so.
 */

export type SummaryModule = 'gops' | 'gchain' | 'ghr' | 'gfin';
export type FigureKind = 'count' | 'money' | 'hours';
export type FigureBasis = 'live' | 'range';

export interface SummaryFigure {
  key: string;
  label: string;
  value: number;
  kind: FigureKind;
  basis: FigureBasis;
  /** 'mine' when the caller can only see their own records of this kind. */
  scope?: 'all' | 'mine';
  to: string;
}

export interface SummaryLine {
  module: SummaryModule;
  label: string;
  to: string;
  /** When the live figures were read — the HR line prints the time. */
  asOf?: string;
  /** HR's day key for the attendance counts (local, never UTC). */
  day?: string;
  figures: SummaryFigure[];
}

export interface CompanySummary {
  range: Range;
  asOf: Date;
  lines: Record<SummaryModule, SummaryLine | null>;
}

export const SUMMARY_MODULES: Record<
  SummaryModule,
  { label: string; to: string; view: string; export: string }
> = {
  gops: { label: 'G-OPS', to: '/g-ops', view: 'gops.dashboard.view_all', export: 'gops.dashboard.export' },
  gchain: { label: 'G-CHAIN', to: '/g-chain', view: 'gchain.dashboard.view_all', export: 'gchain.dashboard.export' },
  ghr: { label: 'G-HR', to: '/g-hr', view: 'ghr.dashboard.view_all', export: 'ghr.dashboard.export' },
  gfin: { label: 'G-FIN', to: '/g-fin', view: 'gfin.dashboard.view_all', export: 'gfin.dashboard.export' },
};

type FigureDef = { module: SummaryModule; label: string; kind: FigureKind; basis: FigureBasis; to: string };

/**
 * THE list of brief figures — label, unit, basis and the screen it opens.
 * The JSON and the CSV both read it, so a label cannot differ between them.
 *
 * Every query string here is a filter the target DataList DECLARES (DataList
 * seeds its filters from declared URL keys only): ar/ap `outstanding` and
 * `overdue`, expenses / leave / purchase-requests / cash-advances / the
 * attendance register / progress reports / service contracts `status`,
 * projects `status` + `type` (the count is PROJECT jobs only), purchase-orders
 * `awaiting`, borrow-slips `overdue`. A figure whose list has no matching
 * filter links to the unfiltered list or its dashboard.
 */
export const SUMMARY_FIGURES: Record<string, FigureDef> = {
  // G-OPS — counts, like the G-OPS dashboard. No "won": the G-OPS dashboard
  // dates it by createdAt and "Winning work" below by decidedAt, and two won
  // figures dated differently on one screen is the Phase 9 failure mode.
  enquiriesInPlay: { module: 'gops', label: 'Enquiries in play', kind: 'count', basis: 'range', to: '/g-ops/leads' },
  quotationsOut: { module: 'gops', label: 'Quotations out', kind: 'count', basis: 'range', to: '/g-ops/quotations' },
  quotationsNegotiating: { module: 'gops', label: 'Quotations in negotiation', kind: 'count', basis: 'range', to: '/g-ops/quotations' },
  projectsInProgress: { module: 'gops', label: 'Projects in progress', kind: 'count', basis: 'live', to: '/g-ops/projects?status=IN_PROGRESS&type=PROJECT' },
  projectsOnHold: { module: 'gops', label: 'Projects on hold', kind: 'count', basis: 'live', to: '/g-ops/projects?status=ON_HOLD&type=PROJECT' },
  reportsAwaitingApproval: { module: 'gops', label: 'Progress reports awaiting approval', kind: 'count', basis: 'live', to: '/g-ops/progress?status=SUBMITTED' },
  contractsRunning: { module: 'gops', label: 'Service contracts running', kind: 'count', basis: 'live', to: '/g-ops/service-contracts?status=ACTIVE' },
  pmAccomplished: { module: 'gops', label: 'PM visits done', kind: 'count', basis: 'range', to: '/g-ops/visits' },
  // G-CHAIN — the four figures the G-CHAIN dashboard shows, nothing it does not.
  requestsAwaitingApproval: { module: 'gchain', label: 'Purchase requests awaiting approval', kind: 'count', basis: 'live', to: '/g-chain/purchase-requests?status=PENDING_APPROVAL' },
  ordersAwaitingDelivery: { module: 'gchain', label: 'Orders awaiting delivery', kind: 'count', basis: 'live', to: '/g-chain/purchase-orders?awaiting=true' },
  borrowSlipsOverdue: { module: 'gchain', label: 'Borrow slips overdue', kind: 'count', basis: 'live', to: '/g-chain/borrow-slips?overdue=true' },
  stockValue: { module: 'gchain', label: 'Stock on hand', kind: 'money', basis: 'live', to: '/g-chain/inventory' },
  // G-HR — counts only, never a person.
  headcount: { module: 'ghr', label: 'Active employees', kind: 'count', basis: 'live', to: '/g-hr/employees' },
  present: { module: 'ghr', label: 'Present today', kind: 'count', basis: 'live', to: '/g-hr/attendance?status=PRESENT' },
  late: { module: 'ghr', label: 'Late today', kind: 'count', basis: 'live', to: '/g-hr/attendance?status=LATE' },
  onLeave: { module: 'ghr', label: 'On leave today', kind: 'count', basis: 'live', to: '/g-hr/leave?status=APPROVED' },
  // Absence is inferred, never stored, so no register can list it — the HR
  // dashboard is the screen that prints this number.
  absent: { module: 'ghr', label: 'Absent today', kind: 'count', basis: 'live', to: '/g-hr' },
  pendingApprovals: { module: 'ghr', label: 'HR approvals waiting', kind: 'count', basis: 'live', to: '/g-hr' },
  overtimeHours: { module: 'ghr', label: 'Overtime approved', kind: 'hours', basis: 'range', to: '/g-hr/reports' },
  overtimeAmount: { module: 'ghr', label: 'Overtime charged to projects', kind: 'money', basis: 'range', to: '/g-hr/reports' },
  // G-FIN — the finance dashboard's position, through financePosition().
  receivable: { module: 'gfin', label: 'Receivable', kind: 'money', basis: 'live', to: '/g-fin/ar?outstanding=true' },
  receivableOverdue: { module: 'gfin', label: 'Receivable overdue', kind: 'money', basis: 'live', to: '/g-fin/ar?overdue=true' },
  payable: { module: 'gfin', label: 'Payable', kind: 'money', basis: 'live', to: '/g-fin/ap?outstanding=true' },
  payableOverdue: { module: 'gfin', label: 'Payable overdue', kind: 'money', basis: 'live', to: '/g-fin/ap?overdue=true' },
  reimbursable: { module: 'gfin', label: 'Owed to staff', kind: 'money', basis: 'live', to: '/g-fin/expenses?status=APPROVED' },
  advancesToRelease: { module: 'gfin', label: 'Advances approved, not released', kind: 'money', basis: 'live', to: '/g-fin/cash-advances?status=APPROVED' },
  workingPosition: { module: 'gfin', label: 'Working position', kind: 'money', basis: 'live', to: '/g-fin' },
  collectedInRange: { module: 'gfin', label: 'Collected', kind: 'money', basis: 'range', to: '/g-fin/payments' },
  billingsAwaitingInvoice: { module: 'gfin', label: 'Approved billings not invoiced', kind: 'count', basis: 'live', to: '/g-fin/ar' },
};

const sees = (me: ResolvedUser, key: string) => me.isSuperAdmin || me.permissions.has(key);

function figure(key: string, value: number, scope?: 'all' | 'mine'): SummaryFigure {
  const def = SUMMARY_FIGURES[key];
  return {
    key,
    label: def.label,
    value,
    kind: def.kind,
    basis: def.basis,
    ...(scope ? { scope } : {}),
    to: def.to,
  };
}

function line(module: SummaryModule, figures: SummaryFigure[], extra: Partial<SummaryLine> = {}): SummaryLine {
  return { module, label: SUMMARY_MODULES[module].label, to: SUMMARY_MODULES[module].to, ...extra, figures };
}

const ymd = (d: Date) => d.toISOString().slice(0, 10);

/**
 * The brief. `query` is the request's raw `from`/`to`: G-OPS and the HR
 * overtime report parse their own strings, and the brief must hand each of
 * them exactly what its own screen would. `asOf` is captured ONCE by the
 * caller, so every live figure on the panel is read at the same instant.
 */
export async function companySummary(
  me: ResolvedUser,
  query: { from?: unknown; to?: unknown },
  asOf: Date = new Date(),
): Promise<CompanySummary> {
  const fromRaw = typeof query.from === 'string' && query.from ? query.from : undefined;
  const toRaw = typeof query.to === 'string' && query.to ? query.to : undefined;
  const range = parseRange(fromRaw, toRaw);
  const today = dayKey(asOf);

  const [gops, gchain, ghr, gfin] = await Promise.all([
    sees(me, SUMMARY_MODULES.gops.view) ? gopsLine(me, fromRaw ?? ymd(range.from), toRaw ?? ymd(range.to)) : null,
    sees(me, SUMMARY_MODULES.gchain.view) ? chainLine(me) : null,
    sees(me, SUMMARY_MODULES.ghr.view) ? hrLine(me, asOf, fromRaw, toRaw) : null,
    sees(me, SUMMARY_MODULES.gfin.view) ? finLine(range, today) : null,
  ]);

  return { range, asOf, lines: { gops, gchain, ghr, gfin } };
}

async function gopsLine(me: ResolvedUser, from: string, to: string): Promise<SummaryLine> {
  const o = await gopsOverview(me, { from, to });
  const figures: SummaryFigure[] = [];
  const sum = (t: Record<string, number>, keys: string[]) => keys.reduce((s, k) => s + (t[k] ?? 0), 0);

  if (o.sales?.leads) {
    figures.push(
      figure('enquiriesInPlay', sum(o.sales.leads, ['NEW', 'CONTACTED', 'QUALIFIED', 'SITE_VISIT']), o._scope.leads),
    );
  }
  if (o.sales?.quotations) {
    figures.push(figure('quotationsOut', o.sales.quotations.SUBMITTED ?? 0, o._scope.quotations));
    figures.push(figure('quotationsNegotiating', o.sales.quotations.NEGOTIATION ?? 0, o._scope.quotations));
  }
  if (o.delivery?.jobs) {
    figures.push(figure('projectsInProgress', o.delivery.jobs.IN_PROGRESS ?? 0, 'all'));
    figures.push(figure('projectsOnHold', o.delivery.jobs.ON_HOLD ?? 0, 'all'));
  }
  if (o.delivery && o.delivery.reportsAwaitingApproval !== null) {
    figures.push(figure('reportsAwaitingApproval', o.delivery.reportsAwaitingApproval, 'all'));
  }
  if (o.aftermarket && o.aftermarket.activeContracts !== null) {
    figures.push(figure('contractsRunning', o.aftermarket.activeContracts, 'all'));
  }
  if (o.aftermarket && o.aftermarket.pmAccomplished !== null) {
    figures.push(figure('pmAccomplished', o.aftermarket.pmAccomplished, 'all'));
  }
  return line('gops', figures);
}

async function chainLine(me: ResolvedUser): Promise<SummaryLine> {
  const c = await chainOverview(me);
  // Scoped exactly as chainOverview scopes it: a view_own holder counts
  // their own requests.
  const requestsScope =
    !me.isSuperAdmin && !me.permissions.has('gchain.purchase_requests.view_all') ? 'mine' : 'all';
  const figures: SummaryFigure[] = [];
  if (c.requestsAwaitingApproval !== null) {
    figures.push(figure('requestsAwaitingApproval', c.requestsAwaitingApproval, requestsScope));
  }
  if (c.ordersAwaitingDelivery !== null) figures.push(figure('ordersAwaitingDelivery', c.ordersAwaitingDelivery));
  if (c.borrowSlipsOverdue !== null) figures.push(figure('borrowSlipsOverdue', c.borrowSlipsOverdue));
  if (c.stock !== null) figures.push(figure('stockValue', c.stock.value));
  return line('gchain', figures);
}

/**
 * The HR window for overtime, parsed exactly as `/hr-reports/overtime-by-project`
 * parses it (raw strings, HR's local `dayKey`) — NOT through `parseRange`,
 * whose end-of-day UTC instant is already tomorrow in Manila.
 */
export function hrReportWindow(fromRaw?: string, toRaw?: string): { from: Date; to: Date } {
  const from = fromRaw ? new Date(fromRaw) : new Date(new Date().getFullYear(), 0, 1);
  const to = toRaw ? new Date(toRaw) : new Date();
  return { from: hrDayKey(from), to: hrDayKey(to) };
}

async function hrLine(
  me: ResolvedUser,
  asOf: Date,
  fromRaw: string | undefined,
  toRaw: string | undefined,
): Promise<SummaryLine> {
  const seesReports = sees(me, 'ghr.reports.view_all');
  const window = hrReportWindow(fromRaw, toRaw);
  const [d, overtime] = await Promise.all([
    attendanceDay(asOf),
    seesReports
      ? prisma.overtimeRequest.aggregate({
          where: { stage: 'APPROVED', date: { gte: window.from, lte: window.to }, jobId: { not: null } },
          _sum: { actualHours: true, amount: true },
        })
      : null,
  ]);
  // Counts only leave this function. `d.rows` carries names and employee
  // numbers and stays behind HR's own screens.
  const figures = [
    figure('headcount', d.headcount),
    figure('present', d.summary.present),
    figure('late', d.summary.late),
    figure('onLeave', d.summary.onLeave),
    figure('absent', d.summary.absent),
    figure('pendingApprovals', d.summary.pendingApprovals),
  ];
  if (overtime) {
    figures.push(figure('overtimeHours', Math.round(num(overtime._sum.actualHours) * 100) / 100));
    figures.push(figure('overtimeAmount', cents(num(overtime._sum.amount))));
  }
  return line('ghr', figures, { asOf: asOf.toISOString(), day: ymd(d.date) });
}

async function finLine(range: Range, today: Date): Promise<SummaryLine> {
  const [p, collected, billingsAwaitingInvoice] = await Promise.all([
    financePosition(today),
    // Customer receipts only — an advance refund is cash in, never a collection.
    prisma.payment.aggregate({
      where: { kind: 'RECEIPT', customerId: { not: null }, clearedAt: { gte: range.from, lte: range.to } },
      _sum: { amount: true },
    }),
    prisma.progressBilling.count({ where: { status: 'APPROVED', invoice: null } }),
  ]);
  return line('gfin', [
    figure('receivable', p.receivable),
    figure('receivableOverdue', p.receivableOverdue),
    figure('payable', p.payable),
    figure('payableOverdue', p.payableOverdue),
    figure('reimbursable', p.reimbursable),
    figure('advancesToRelease', p.advancesToRelease),
    figure('workingPosition', p.workingPosition),
    figure('collectedInRange', cents(num(collected._sum.amount))),
    figure('billingsAwaitingInvoice', billingsAwaitingInvoice),
  ]);
}

/** A figure as the CSV prints it: money and hours to 2dp, counts whole. */
export function figureCell(f: Pick<SummaryFigure, 'kind' | 'value'>): string {
  return f.kind === 'count' ? String(Math.round(f.value)) : f.value.toFixed(2);
}

export const SUMMARY_CSV_HEADER = ['Module', 'Figure', 'Value', 'Basis', 'Scope', 'From', 'To', 'Opens'];

/**
 * One CSV row per figure. A module's rows need that module's dashboard
 * EXPORT as well as its view — seeing a number on screen is not the right to
 * take a file of it out of the building.
 */
export function summaryCsvRows(summary: CompanySummary, me: ResolvedUser): string[][] {
  const rows: string[][] = [];
  for (const module of Object.keys(SUMMARY_MODULES) as SummaryModule[]) {
    const l = summary.lines[module];
    if (!l || !sees(me, SUMMARY_MODULES[module].export)) continue;
    for (const f of l.figures) {
      rows.push([
        l.label,
        f.label,
        figureCell(f),
        f.basis,
        f.scope ?? 'all',
        f.basis === 'range' ? ymd(summary.range.from) : '',
        f.basis === 'range' ? ymd(summary.range.to) : '',
        f.to,
      ]);
    }
  }
  return rows;
}

// ── Formatting for CSV ───────────────────────────────────────────────────────

/** RFC 4180 with a BOM, because Excel opens UTF-8 as mojibake without one. */
export function toCsv(header: string[], rows: (string | number | null | undefined)[][]): string {
  const cell = (v: string | number | null | undefined) => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return `﻿${[header, ...rows].map((r) => r.map(cell).join(',')).join('\r\n')}`;
}
