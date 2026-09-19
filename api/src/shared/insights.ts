import { Prisma } from '@prisma/client';
import { prisma } from '../prisma';
import { badRequest } from '../http/kit';

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

export const dayKey = (at: Date): Date =>
  new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));

export function monthKey(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** A list of month keys, oldest first, ending with the month `to` falls in. */
export function monthsBack(count: number, to = new Date()): string[] {
  const out: string[] = [];
  for (let i = count - 1; i >= 0; i--) {
    out.push(monthKey(new Date(Date.UTC(to.getUTCFullYear(), to.getUTCMonth() - i, 1))));
  }
  return out;
}

export interface Range {
  from: Date;
  to: Date;
}

/**
 * The window a report covers.
 *
 * Defaults to the current year rather than "everything", because a report over
 * all of history answers a different question than the one anybody asked.
 */
export function parseRange(fromRaw?: string, toRaw?: string): Range {
  const now = new Date();
  const from = fromRaw ? new Date(fromRaw) : new Date(Date.UTC(now.getUTCFullYear(), 0, 1));
  const to = toRaw ? new Date(toRaw) : now;
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
    throw badRequest('That is not a valid date range');
  }
  if (to < from) throw badRequest('The range ends before it starts');
  return { from: dayKey(from), to: dayKey(to) };
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
  if (opts.range) where.createdAt = { gte: opts.range.from, lte: opts.range.to };

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
  payable: number;
  reimbursable: number;
  committed: number;
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

// ── Formatting for CSV ───────────────────────────────────────────────────────

/** RFC 4180 with a BOM, because Excel opens UTF-8 as mojibake without one. */
export function toCsv(header: string[], rows: (string | number | null | undefined)[][]): string {
  const cell = (v: string | number | null | undefined) => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return `﻿${[header, ...rows].map((r) => r.map(cell).join(',')).join('\r\n')}`;
}
