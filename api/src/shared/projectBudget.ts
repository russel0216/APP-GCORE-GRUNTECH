import { Prisma } from '@prisma/client';
import { prisma } from '../prisma';

/**
 * A project's budget by budget line, as Budget Monitoring reads it — and what
 * is still WAITING on each line (2026-11-09, the owner's question: "how can
 * we see if the request in Reimbursement appear or allocated already in
 * budget monitoring prior approval to see if there is remaining budget").
 *
 * The ledger (`JobCostEntry`) carries only what has happened: BUDGETED,
 * COMMITTED, INCURRED, CONSUMED. A reimbursement charged to a project posts
 * INCURRED on its last signature and nothing before, so an approver reading
 * Budget Monitoring saw no trace of the claim in front of them. `requested`
 * is the money asked on the line that has posted nothing yet — expense
 * claims (reimbursements and liquidations) pending approval, cash advances
 * charged to the line and not yet liquidated (a loan is never liquidated to
 * a project and is left out), and budget requests approved or pending but
 * not yet released (released cash is already COMMITTED). It is SHOWN beside
 * Available and never subtracted from it — Available stays budgeted −
 * committed − incurred, Phase 4's rule — so a figure that may yet be
 * returned or rejected never reads as spent.
 *
 * One rule, read by Budget Monitoring, the purchase requisition's budget
 * panel, the budget request's, the expense claim's and the cash advance's
 * "Against the project budget" cards, so no two screens disagree.
 */

const num = (v: Prisma.Decimal | null | undefined) => (v == null ? 0 : Number(v));
const cents = (n: number) => Math.round(n * 100) / 100;

export interface BudgetLine {
  id: string;
  code: string;
  name: string;
  budgeted: number;
  committed: number;
  incurred: number;
  consumed: number;
  /** Asked on this line and not yet posted: pending claims, advances out, budget requests not yet released. */
  requested: number;
  available: number;
}

export interface BudgetPool {
  lines: BudgetLine[];
  total: Omit<BudgetLine, 'id' | 'code' | 'name'>;
}

/** The document whose own figure a reading leaves out of `requested` — it is shown apart as "this claim". */
export interface OwnDocument {
  expenseClaimId?: string;
  cashAdvanceId?: string;
  budgetRequestId?: string;
}

/** A cash advance still to be liquidated to its line — asked, approved or out. */
const ADVANCE_IN_FLIGHT = ['PENDING_APPROVAL', 'APPROVED', 'RELEASED'] as const;
/** A budget request asked and not yet released (released cash is COMMITTED on the ledger). */
const REQUEST_IN_FLIGHT = ['PENDING_APPROVAL', 'APPROVED'] as const;

/**
 * What is waiting on each of a project's budget lines, by cost category id
 * (three queries, whatever the project holds). `own` leaves one document out.
 */
export async function requestedByLine(jobId: string, own: OwnDocument = {}): Promise<Map<string, number>> {
  const [claims, advances, requests] = await Promise.all([
    prisma.expenseClaim.findMany({
      where: { jobId, costCategoryId: { not: null }, status: 'PENDING_APPROVAL', ...(own.expenseClaimId ? { id: { not: own.expenseClaimId } } : {}) },
      select: { costCategoryId: true, total: true, advanceId: true },
    }),
    prisma.cashAdvance.findMany({
      where: {
        jobId,
        costCategoryId: { not: null },
        repayable: false,
        status: { in: [...ADVANCE_IN_FLIGHT] },
        ...(own.cashAdvanceId ? { id: { not: own.cashAdvanceId } } : {}),
      },
      select: { id: true, costCategoryId: true, status: true, amount: true, amountReleased: true },
    }),
    prisma.budgetRequest.findMany({
      where: { jobId, status: { in: [...REQUEST_IN_FLIGHT] }, ...(own.budgetRequestId ? { id: { not: own.budgetRequestId } } : {}) },
      select: { costCategoryId: true, amount: true },
    }),
  ]);
  const out = new Map<string, number>();
  const add = (categoryId: string, amount: number) => out.set(categoryId, cents((out.get(categoryId) ?? 0) + amount));
  // A released advance whose liquidation is already pending is counted once,
  // as the liquidation: the receipts say what will post, not the cash out.
  const liquidating = new Set(claims.map((c) => c.advanceId).filter((id): id is string => !!id));
  for (const c of claims) add(c.costCategoryId!, num(c.total));
  for (const a of advances) {
    if (liquidating.has(a.id)) continue;
    add(a.costCategoryId!, a.status === 'RELEASED' ? num(a.amountReleased) : num(a.amount));
  }
  for (const r of requests) add(r.costCategoryId, num(r.amount));
  return out;
}

/**
 * The project's budget by budget line: budgeted, committed, incurred,
 * consumed, requested and available (`availableBudget()`'s arithmetic,
 * every category in one query), one row per ACTIVE cost category in its
 * order, and the project's whole. A draft commits nothing, so nothing is
 * left out for the request being edited; the page subtracts its own lines
 * live.
 *
 * `exclude` leaves one document's own ledger rows out (a released budget
 * request's commitment), read separately and subtracted — never a `NOT`
 * on the nullable source columns, which would drop every row with none.
 * `own` leaves the same document out of `requested`, so a card shows it
 * once, apart, as "this request". CONSUMED is reported and never
 * subtracted (Phase 4's rule), and so is REQUESTED.
 */
export async function projectBudgetByLine(
  jobId: string,
  opts: { exclude?: { sourceType: string; sourceId: string }; own?: OwnDocument } = {},
): Promise<BudgetPool> {
  const [categories, rows, ownRows, requested] = await Promise.all([
    prisma.costCategory.findMany({
      where: { isActive: true },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
      select: { id: true, code: true, name: true },
    }),
    prisma.jobCostEntry.groupBy({ by: ['costCategoryId', 'state'], where: { jobId }, _sum: { amount: true } }),
    opts.exclude
      ? prisma.jobCostEntry.groupBy({ by: ['costCategoryId', 'state'], where: { jobId, ...opts.exclude }, _sum: { amount: true } })
      : Promise.resolve([]),
    requestedByLine(jobId, opts.own),
  ]);
  type Row = { costCategoryId: string; state: string; _sum: { amount: Prisma.Decimal | null } };
  const sumOf = (list: Row[], categoryId: string | null, state: string) =>
    list
      .filter((r) => (categoryId === null || r.costCategoryId === categoryId) && r.state === state)
      .reduce((s, r) => s + num(r._sum.amount), 0);
  const sum = (categoryId: string | null, state: string) => sumOf(rows, categoryId, state) - sumOf(ownRows, categoryId, state);
  const position = (categoryId: string | null) => {
    const budgeted = sum(categoryId, 'BUDGETED');
    const committed = sum(categoryId, 'COMMITTED');
    const incurred = sum(categoryId, 'INCURRED');
    const asked = categoryId === null ? [...requested.values()].reduce((s, v) => s + v, 0) : (requested.get(categoryId) ?? 0);
    return {
      budgeted: cents(budgeted),
      committed: cents(committed),
      incurred: cents(incurred),
      consumed: cents(sum(categoryId, 'CONSUMED')),
      requested: cents(asked),
      available: cents(budgeted - committed - incurred),
    };
  };
  // An inactive category still carrying ledger rows is listed too, after the active ones.
  const listed = new Set(categories.map((c) => c.id));
  const stray = [...new Set([...rows.map((r) => r.costCategoryId), ...requested.keys()].filter((id) => id && !listed.has(id)))] as string[];
  const extra = stray.length
    ? await prisma.costCategory.findMany({ where: { id: { in: stray } }, orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }], select: { id: true, code: true, name: true } })
    : [];
  return {
    lines: [...categories, ...extra].map((c) => ({ ...c, ...position(c.id) })),
    total: position(null),
  };
}

/** What the card says "this document" means at its status. */
export type ChargeBasis = 'asked' | 'released' | 'settled' | 'closed';

/**
 * "Against the project budget" for ONE document charging ONE budget line:
 * the line as it stands (this document's own ledger rows and its own
 * `requested` figure left out), then this document and what is left after
 * it. `settled` says the document takes nothing more — what it spent is on
 * the ledger (`settled`), or it was refused or withdrawn (`closed`).
 */
export async function chargeAgainstBudget(input: {
  jobId: string;
  costCategoryId: string;
  /** What this document would take from the line now; 0 once settled or closed. */
  amount: number;
  basis: ChargeBasis;
  exclude?: { sourceType: string; sourceId: string };
  own?: OwnDocument;
}) {
  const settled = input.basis === 'settled' || input.basis === 'closed';
  // A settled document's rows ARE the ledger now: the line is read as it
  // stands. Before that, its own rows (a released request's commitment) are
  // left out and shown apart as "this request", never counted twice.
  const pool = await projectBudgetByLine(input.jobId, { exclude: settled ? undefined : input.exclude, own: input.own });
  const thisDocument = settled ? 0 : cents(input.amount);
  const line = pool.lines.find((l) => l.id === input.costCategoryId) ?? null;
  const before = line?.available ?? 0;
  const after = cents(before - thisDocument);
  return {
    source: 'project' as const,
    perLine: true,
    line,
    lines: pool.lines,
    total: pool.total,
    availableBefore: before,
    thisRequest: thisDocument,
    availableAfter: after,
    over: after < 0,
    overBy: after < 0 ? cents(-after) : 0,
    /** Also waiting on this line, besides this document — shown, never subtracted. */
    requested: line?.requested ?? 0,
    settled,
    basis: input.basis,
  };
}

export type ChargeBudget = Awaited<ReturnType<typeof chargeAgainstBudget>>;

/**
 * An expense claim's position: what it would post (its total) while a draft
 * or pending; nothing more once approved (posted as INCURRED), reimbursed,
 * settled, rejected or cancelled. A claim with no project or no budget line
 * has none.
 */
export async function claimBudget(claim: { id: string; jobId: string | null; costCategoryId: string | null; status: string; total: Prisma.Decimal | number }): Promise<ChargeBudget | null> {
  if (!claim.jobId || !claim.costCategoryId) return null;
  const posted = ['APPROVED', 'REIMBURSED', 'SETTLED'].includes(claim.status);
  const closed = ['REJECTED', 'CANCELLED'].includes(claim.status);
  return chargeAgainstBudget({
    jobId: claim.jobId,
    costCategoryId: claim.costCategoryId,
    amount: typeof claim.total === 'number' ? claim.total : num(claim.total),
    basis: posted ? 'settled' : closed ? 'closed' : 'asked',
    exclude: { sourceType: 'expense_claim', sourceId: claim.id },
    own: { expenseClaimId: claim.id },
  });
}

/**
 * A cash advance's position: the amount asked while pending or approved,
 * the cash out once released (to be liquidated to the line), nothing more
 * once liquidated, refused or withdrawn. A loan (`repayable`) is never
 * liquidated to a project and has none.
 */
export async function advanceBudget(advance: {
  id: string;
  jobId: string | null;
  costCategoryId: string | null;
  status: string;
  repayable: boolean;
  amount: Prisma.Decimal | number;
  amountReleased: Prisma.Decimal | number;
}): Promise<ChargeBudget | null> {
  if (!advance.jobId || !advance.costCategoryId || advance.repayable) return null;
  const asNumber = (v: Prisma.Decimal | number) => (typeof v === 'number' ? v : num(v));
  const released = advance.status === 'RELEASED';
  const asked = ['DRAFT', 'PENDING_APPROVAL', 'APPROVED'].includes(advance.status);
  const closed = ['REJECTED', 'CANCELLED'].includes(advance.status);
  return chargeAgainstBudget({
    jobId: advance.jobId,
    costCategoryId: advance.costCategoryId,
    amount: released ? asNumber(advance.amountReleased) : asNumber(advance.amount),
    basis: released ? 'released' : asked ? 'asked' : closed ? 'closed' : 'settled',
    own: { cashAdvanceId: advance.id },
  });
}

/**
 * The approvers' bell and queue say where the line stands, as it stood at
 * submit: "Materials: PHP 120,000.00 available → PHP 95,000.00 left", or
 * "… available, over by …".
 */
export function budgetPosition(b: ChargeBudget, lineName: string, money: (n: number) => string): string {
  return b.over
    ? `${lineName}: ${money(b.availableBefore)} available, over by ${money(b.overBy)}`
    : `${lineName}: ${money(b.availableBefore)} available → ${money(b.availableAfter)} left`;
}
