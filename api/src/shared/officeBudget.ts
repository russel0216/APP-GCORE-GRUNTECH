import { Prisma } from '@prisma/client';
import { prisma } from '../prisma';
import { badRequest } from '../http/kit';

/**
 * OFFICE BUDGETS (2026-11-10, the owner's call: "on Budget Request and
 * Reimbursement add an office budget monitoring where they can charge —
 * yearly, can be edited or created", his two Builk monitors as the sample).
 *
 * A budget is a named year of coded lines (`OfficeBudget`, `OfficeBudgetLine`).
 * A reimbursement, a budget request, a cash advance and a supplier bill with
 * no purchase order may charge ONE line instead of a project. Nothing is
 * stored on the line but its budget and its opening actual (what the old
 * monitor had spent when it was brought over); everything else is READ off
 * the documents, here and only here:
 *
 * - **requested** — asked and not yet decided or released: reimbursements and
 *   supplier bills pending approval, budget requests and cash advances pending
 *   or approved. Shown, never subtracted (it may yet be returned or refused —
 *   the project budget's rule).
 * - **released** — cash out and not yet accounted for: a released budget
 *   request until its liquidation is approved, a released advance until it is
 *   liquidated (a loan: until repaid, by what is still owed).
 * - **actual** — the opening actual, plus approved reimbursements and
 *   liquidations at their total, plus approved supplier bills at their
 *   subtotal (input VAT is recoverable — the job-cost rule).
 * - **remaining** = budget − released − actual.
 *
 * A liquidation takes its request's or advance's line, so the cash out is
 * counted once: as released until the liquidation is approved, then as actual.
 * Over budget is SAID, with the lines of the same budget that still have room
 * (the owner's call: "suggest to allocate on a different line"), never refused.
 */

const num = (v: Prisma.Decimal | number | null | undefined) => (v == null ? 0 : Number(v));
const cents = (n: number) => Math.round(n * 100) / 100;

/** The document a reading leaves out — the card shows it apart, as "this claim". */
export interface OfficeOwn {
  expenseClaimId?: string;
  cashAdvanceId?: string;
  budgetRequestId?: string;
  supplierBillId?: string;
}

export interface OfficeFigures {
  requested: number;
  released: number;
  /** Spent by documents — the opening actual is added by the caller. */
  spent: number;
}

const SPENT_CLAIM = ['APPROVED', 'REIMBURSED', 'SETTLED'] as const;
const SPENT_BILL = ['APPROVED', 'PARTIALLY_PAID', 'PAID'] as const;
const ASKED = ['PENDING_APPROVAL', 'APPROVED'] as const;

const not = (id?: string) => (id ? { id: { not: id } } : {});

/** What the documents say about each line (four queries, whatever the lines hold). */
export async function officeFigures(lineIds: string[], own: OfficeOwn = {}): Promise<Map<string, OfficeFigures>> {
  const out = new Map<string, OfficeFigures>(lineIds.map((id) => [id, { requested: 0, released: 0, spent: 0 }]));
  if (!lineIds.length) return out;
  const on = { officeBudgetLineId: { in: lineIds } };
  const [claims, bills, requests, advances] = await Promise.all([
    prisma.expenseClaim.findMany({
      where: { ...on, status: { in: ['PENDING_APPROVAL', ...SPENT_CLAIM] }, ...not(own.expenseClaimId) },
      select: { officeBudgetLineId: true, status: true, total: true, advanceId: true, budgetRequestId: true },
    }),
    prisma.supplierBill.findMany({
      where: { ...on, status: { in: ['PENDING_APPROVAL', ...SPENT_BILL] }, ...not(own.supplierBillId) },
      select: { officeBudgetLineId: true, status: true, subtotal: true },
    }),
    prisma.budgetRequest.findMany({
      // A request finance paid directly (a travel booking) is spent with no claim behind it.
      where: { ...on, OR: [{ status: { in: [...ASKED, 'RELEASED'] } }, { status: 'LIQUIDATED', paidDirect: true }], ...not(own.budgetRequestId) },
      select: { officeBudgetLineId: true, status: true, amount: true, amountReleased: true, amountSpent: true },
    }),
    prisma.cashAdvance.findMany({
      where: { ...on, status: { in: [...ASKED, 'RELEASED'] }, ...not(own.cashAdvanceId) },
      select: { officeBudgetLineId: true, status: true, amount: true, amountReleased: true, amountRefunded: true, repayable: true },
    }),
  ]);
  const at = (id: string | null) => out.get(id ?? '')!;
  for (const c of claims) {
    const f = at(c.officeBudgetLineId);
    if (c.status === 'PENDING_APPROVAL') {
      // A pending liquidation is its request's cash, already counted as released.
      if (!c.advanceId && !c.budgetRequestId) f.requested += num(c.total);
    } else f.spent += num(c.total);
  }
  for (const b of bills) {
    const f = at(b.officeBudgetLineId);
    if (b.status === 'PENDING_APPROVAL') f.requested += num(b.subtotal);
    else f.spent += num(b.subtotal);
  }
  for (const r of requests) {
    const f = at(r.officeBudgetLineId);
    if (r.status === 'LIQUIDATED') f.spent += num(r.amountSpent);
    else if (r.status === 'RELEASED') f.released += num(r.amountReleased);
    else f.requested += num(r.amount);
  }
  for (const a of advances) {
    const f = at(a.officeBudgetLineId);
    if (a.status === 'RELEASED') f.released += Math.max(0, num(a.amountReleased) - (a.repayable ? num(a.amountRefunded) : 0));
    else f.requested += num(a.amount);
  }
  // Charged line by line (2026-11-11): each receipt and item on its own office line.
  const [claimLines, items] = await Promise.all([
    prisma.expenseClaimLine.findMany({
      where: { ...on, claim: { split: true, status: { in: ['PENDING_APPROVAL', ...SPENT_CLAIM] }, ...not(own.expenseClaimId) } },
      select: { officeBudgetLineId: true, amount: true, claim: { select: { status: true, budgetRequestId: true } } },
    }),
    prisma.budgetRequestItem.findMany({
      where: { ...on, request: { split: true, status: { in: [...ASKED, 'RELEASED'] }, ...not(own.budgetRequestId) } },
      select: { officeBudgetLineId: true, amount: true, request: { select: { status: true, amount: true, amountReleased: true } } },
    }),
  ]);
  for (const l of claimLines) {
    const f = at(l.officeBudgetLineId);
    if (l.claim.status === 'PENDING_APPROVAL') {
      if (!l.claim.budgetRequestId) f.requested += num(l.amount);
    } else f.spent += num(l.amount);
  }
  for (const i of items) {
    const f = at(i.officeBudgetLineId);
    const asked = num(i.request.amount);
    if (i.request.status === 'RELEASED') f.released += asked > 0 ? (num(i.request.amountReleased) * num(i.amount)) / asked : 0;
    else f.requested += num(i.amount);
  }
  for (const f of out.values()) {
    f.requested = cents(f.requested);
    f.released = cents(f.released);
    f.spent = cents(f.spent);
  }
  return out;
}

export interface OfficeLine {
  id: string;
  code: string;
  name: string;
  notes: string | null;
  isActive: boolean;
  budget: number;
  openingActual: number;
  requested: number;
  released: number;
  /** The opening actual and what the documents spent. */
  actual: number;
  remaining: number;
  /** Actual and cash out over the budget, to one decimal; null with no budget. */
  usedPct: number | null;
  over: boolean;
}

type LineRow = { id: string; code: string; name: string; notes: string | null; isActive: boolean; amount: Prisma.Decimal; openingActual: Prisma.Decimal };

function positionOf(l: LineRow, f: OfficeFigures): OfficeLine {
  const budget = num(l.amount);
  const opening = num(l.openingActual);
  const actual = cents(opening + f.spent);
  const remaining = cents(budget - f.released - actual);
  return {
    id: l.id,
    code: l.code,
    name: l.name,
    notes: l.notes,
    isActive: l.isActive,
    budget,
    openingActual: opening,
    requested: f.requested,
    released: f.released,
    actual,
    remaining,
    usedPct: budget > 0 ? Math.round(((actual + f.released) / budget) * 1000) / 10 : null,
    over: remaining < 0,
  };
}

function totalOf(lines: OfficeLine[]) {
  const sum = (k: 'budget' | 'openingActual' | 'requested' | 'released' | 'actual' | 'remaining') => cents(lines.reduce((s, l) => s + l[k], 0));
  const budget = sum('budget');
  const actual = sum('actual');
  const released = sum('released');
  return {
    budget,
    openingActual: sum('openingActual'),
    requested: sum('requested'),
    released,
    actual,
    remaining: sum('remaining'),
    usedPct: budget > 0 ? Math.round(((actual + released) / budget) * 1000) / 10 : null,
    over: lines.filter((l) => l.over).length,
  };
}

const LINE_ORDER = [{ sortOrder: 'asc' as const }, { code: 'asc' as const }];

/** One budget, every line with its position, and the whole. */
export async function officeBudgetPosition(budgetId: string, own: OfficeOwn = {}) {
  const budget = await prisma.officeBudget.findUnique({ where: { id: budgetId }, include: { lines: { orderBy: LINE_ORDER } } });
  if (!budget) return null;
  const figures = await officeFigures(budget.lines.map((l) => l.id), own);
  const lines = budget.lines.map((l) => positionOf(l, figures.get(l.id)!));
  return {
    budget: { id: budget.id, year: budget.year, name: budget.name, notes: budget.notes, isActive: budget.isActive },
    lines,
    total: totalOf(lines),
  };
}

/** Every budget of a year with its totals — the page's list. */
export async function officeBudgetsOfYear(year: number) {
  const budgets = await prisma.officeBudget.findMany({ where: { year }, orderBy: [{ name: 'asc' }], include: { lines: { orderBy: LINE_ORDER } } });
  const figures = await officeFigures(budgets.flatMap((b) => b.lines.map((l) => l.id)));
  return budgets.map((b) => {
    const lines = b.lines.map((l) => positionOf(l, figures.get(l.id)!));
    return { id: b.id, year: b.year, name: b.name, notes: b.notes, isActive: b.isActive, lineCount: lines.length, total: totalOf(lines) };
  });
}

/** What the forms offer: the active lines of the active budgets, with what is left. */
export async function officeLineOptions() {
  const budgets = await prisma.officeBudget.findMany({
    where: { isActive: true },
    orderBy: [{ year: 'desc' }, { name: 'asc' }],
    include: { lines: { where: { isActive: true }, orderBy: LINE_ORDER } },
  });
  const figures = await officeFigures(budgets.flatMap((b) => b.lines.map((l) => l.id)));
  return budgets.map((b) => ({
    id: b.id,
    year: b.year,
    name: b.name,
    lines: b.lines.map((l) => {
      const p = positionOf(l, figures.get(l.id)!);
      return { id: l.id, code: l.code, name: l.name, budget: p.budget, remaining: p.remaining, requested: p.requested };
    }),
  }));
}

export const OFFICE_LINE_SELECT = {
  select: { id: true, code: true, name: true, budget: { select: { id: true, name: true, year: true } } },
} as const;

/**
 * The line a document may charge: on file, active, in an active budget — or
 * the one it already carries (`keep`), whatever became of it since.
 */
export async function officeLineFor(id: string, keep?: string | null) {
  const line = await prisma.officeBudgetLine.findUnique({ where: { id }, include: { budget: { select: { id: true, name: true, year: true, isActive: true } } } });
  if (!line) throw badRequest('That office budget line is not on file');
  if (id !== keep && (!line.isActive || !line.budget.isActive)) {
    throw badRequest(`${line.code} ${line.name} is closed — choose another line of ${line.budget.name}`);
  }
  return line;
}

/** A project or an office budget line, never both. */
export function assertOneCharge(jobId: string | null | undefined, officeBudgetLineId: string | null | undefined) {
  if (jobId && officeBudgetLineId) throw badRequest('Charge it to a project or to an office budget line, not both');
}

export type OfficeBasis = 'asked' | 'released' | 'settled' | 'closed';

/**
 * "Against the office budget" for ONE document charging ONE line — in the
 * project budget card's shape (`chargeAgainstBudget()`), so one card draws
 * both: committed is the cash out, incurred the actual. Over, it names the
 * lines of the same budget with room for the document.
 */
export async function chargeAgainstOffice(input: { lineId: string; amount: number; basis: OfficeBasis; own: OfficeOwn }) {
  const line = await prisma.officeBudgetLine.findUnique({ where: { id: input.lineId }, select: { budgetId: true } });
  if (!line) return null;
  const settled = input.basis === 'settled' || input.basis === 'closed';
  const pool = (await officeBudgetPosition(line.budgetId, settled ? {} : input.own))!;
  const shape = (l: OfficeLine) => ({
    id: l.id,
    code: l.code,
    name: `${l.code} ${l.name}`,
    budgeted: l.budget,
    committed: l.released,
    incurred: l.actual,
    consumed: 0,
    requested: l.requested,
    available: l.remaining,
  });
  const mine = pool.lines.find((l) => l.id === input.lineId)!;
  const thisDocument = settled ? 0 : cents(input.amount);
  const after = cents(mine.remaining - thisDocument);
  const over = after < 0;
  return {
    source: 'office' as const,
    perLine: true,
    office: pool.budget,
    line: shape(mine),
    lines: pool.lines.filter((l) => l.isActive || l.id === input.lineId).map(shape),
    total: {
      budgeted: pool.total.budget,
      committed: pool.total.released,
      incurred: pool.total.actual,
      consumed: 0,
      requested: pool.total.requested,
      available: pool.total.remaining,
    },
    availableBefore: mine.remaining,
    thisRequest: thisDocument,
    availableAfter: after,
    over,
    overBy: over ? cents(-after) : 0,
    requested: mine.requested,
    settled,
    basis: input.basis,
    /** Over: the other open lines of this budget that could take it whole. */
    suggest:
      over && !settled
        ? pool.lines
            .filter((l) => l.isActive && l.id !== input.lineId && l.remaining >= thisDocument)
            .sort((a, b) => b.remaining - a.remaining)
            .slice(0, 5)
            .map((l) => ({ id: l.id, code: l.code, name: l.name, remaining: l.remaining }))
        : [],
  };
}

export type OfficeCharge = NonNullable<Awaited<ReturnType<typeof chargeAgainstOffice>>>;

type Money = Prisma.Decimal | number;

/** A reimbursement or a liquidation: its total until approved, then on the line as actual. */
export async function claimOffice(claim: { id: string; officeBudgetLineId: string | null; status: string; total: Money; advanceId?: string | null; budgetRequestId?: string | null }) {
  if (!claim.officeBudgetLineId) return null;
  const posted = (SPENT_CLAIM as readonly string[]).includes(claim.status);
  const closed = ['REJECTED', 'CANCELLED'].includes(claim.status);
  return chargeAgainstOffice({
    lineId: claim.officeBudgetLineId,
    amount: num(claim.total),
    basis: posted ? 'settled' : closed ? 'closed' : 'asked',
    // A liquidation's cash is its request's: left out too, so it is not counted beside the receipts.
    own: { expenseClaimId: claim.id, cashAdvanceId: claim.advanceId ?? undefined, budgetRequestId: claim.budgetRequestId ?? undefined },
  });
}

/** A budget request: the amount asked, the cash out once released, nothing more once liquidated. */
export async function requestOffice(request: { id: string; officeBudgetLineId: string | null; status: string; amount: Money; amountReleased: Money }) {
  if (!request.officeBudgetLineId) return null;
  const released = request.status === 'RELEASED';
  const asked = ['DRAFT', 'PENDING_APPROVAL', 'APPROVED'].includes(request.status);
  const closed = ['REJECTED', 'CANCELLED'].includes(request.status);
  return chargeAgainstOffice({
    lineId: request.officeBudgetLineId,
    amount: released ? num(request.amountReleased) : num(request.amount),
    basis: released ? 'released' : asked ? 'asked' : closed ? 'closed' : 'settled',
    // Settled, the line is read as it stands — a direct payment's own spend with it.
    own: released || asked ? { budgetRequestId: request.id } : {},
  });
}

/** A cash advance: asked, then the cash still out (a loan: what is still owed). */
export async function advanceOffice(advance: { id: string; officeBudgetLineId: string | null; status: string; repayable: boolean; amount: Money; amountReleased: Money; amountRefunded: Money }) {
  if (!advance.officeBudgetLineId) return null;
  const released = advance.status === 'RELEASED';
  const asked = ['DRAFT', 'PENDING_APPROVAL', 'APPROVED'].includes(advance.status);
  const closed = ['REJECTED', 'CANCELLED'].includes(advance.status);
  return chargeAgainstOffice({
    lineId: advance.officeBudgetLineId,
    amount: released ? Math.max(0, num(advance.amountReleased) - (advance.repayable ? num(advance.amountRefunded) : 0)) : num(advance.amount),
    basis: released ? 'released' : asked ? 'asked' : closed ? 'closed' : 'settled',
    own: { cashAdvanceId: advance.id },
  });
}

/** A supplier bill with no purchase order: its subtotal until approved, then actual. */
export async function billOffice(bill: { id: string; officeBudgetLineId: string | null; status: string; subtotal: Money }) {
  if (!bill.officeBudgetLineId) return null;
  const posted = (SPENT_BILL as readonly string[]).includes(bill.status);
  const closed = ['REJECTED', 'CANCELLED'].includes(bill.status);
  return chargeAgainstOffice({
    lineId: bill.officeBudgetLineId,
    amount: num(bill.subtotal),
    basis: posted ? 'settled' : closed ? 'closed' : 'asked',
    own: { supplierBillId: bill.id },
  });
}

/** The approvers' bell: "Yearly Budget › 214 TRAVEL EXPENSE: PHP … left → PHP … after", or over, with where there is room. */
export function officePosition(b: OfficeCharge, money: (n: number) => string): string {
  const line = `${b.office.name} › ${b.line.name}`;
  if (!b.over) return `${line}: ${money(b.availableBefore)} left → ${money(b.availableAfter)} after`;
  const room = b.suggest.length ? `; room on ${b.suggest.slice(0, 2).map((s) => `${s.code} ${s.name}`).join(' or ')}` : '';
  return `${line}: ${money(b.availableBefore)} left, over by ${money(b.overBy)}${room}`;
}

/** The documents charged to a budget's lines (or one line) — the page's drill-down. */
export async function officeDocuments(lineIds: string[]) {
  if (!lineIds.length) return [];
  const on = { officeBudgetLineId: { in: lineIds } };
  const [claims, bills, requests, advances] = await Promise.all([
    prisma.expenseClaim.findMany({
      where: { ...on, status: { notIn: ['DRAFT', 'REJECTED', 'CANCELLED'] } },
      select: { id: true, number: true, status: true, total: true, claimDate: true, purpose: true, officeBudgetLineId: true, advanceId: true, budgetRequestId: true, claimedBy: { select: { name: true } } },
    }),
    prisma.supplierBill.findMany({
      where: { ...on, status: { notIn: ['DRAFT', 'CANCELLED'] } },
      select: { id: true, number: true, status: true, subtotal: true, billDate: true, officeBudgetLineId: true, supplier: { select: { name: true } } },
    }),
    prisma.budgetRequest.findMany({
      where: { ...on, status: { notIn: ['DRAFT', 'REJECTED', 'CANCELLED'] } },
      select: { id: true, number: true, status: true, amount: true, createdAt: true, reason: true, officeBudgetLineId: true, requestedBy: { select: { name: true } } },
    }),
    prisma.cashAdvance.findMany({
      where: { ...on, status: { notIn: ['DRAFT', 'REJECTED', 'CANCELLED'] } },
      select: { id: true, number: true, status: true, amount: true, requestDate: true, purpose: true, officeBudgetLineId: true, requestedBy: { select: { name: true } } },
    }),
  ]);
  const rows = [
    ...claims.map((c) => ({
      kind: c.advanceId || c.budgetRequestId ? ('liquidation' as const) : ('reimbursement' as const),
      id: c.id, number: c.number, status: c.status as string, amount: num(c.total), date: c.claimDate, what: c.purpose, who: c.claimedBy.name,
      lineId: c.officeBudgetLineId!, link: `/g-fin/expenses/${c.id}`,
    })),
    ...bills.map((b) => ({
      kind: 'bill' as const, id: b.id, number: b.number, status: b.status as string, amount: num(b.subtotal), date: b.billDate, what: 'Supplier bill', who: b.supplier.name,
      lineId: b.officeBudgetLineId!, link: `/g-fin/ap/${b.id}`,
    })),
    ...requests.map((r) => ({
      kind: 'budget_request' as const, id: r.id, number: r.number, status: r.status as string, amount: num(r.amount), date: r.createdAt, what: r.reason, who: r.requestedBy.name,
      lineId: r.officeBudgetLineId!, link: `/g-ops/budget-requests/${r.id}`,
    })),
    ...advances.map((a) => ({
      kind: 'cash_advance' as const, id: a.id, number: a.number, status: a.status as string, amount: num(a.amount), date: a.requestDate, what: a.purpose, who: a.requestedBy.name,
      lineId: a.officeBudgetLineId!, link: `/g-fin/cash-advances/${a.id}`,
    })),
  ];
  return rows.sort((a, b) => b.date.getTime() - a.date.getTime());
}

/** How many documents name each line — a line in use is closed, never removed. */
export async function officeLineUse(lineIds: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>(lineIds.map((id) => [id, 0]));
  if (!lineIds.length) return out;
  const where = { officeBudgetLineId: { in: lineIds } };
  const by = { by: ['officeBudgetLineId'] as ['officeBudgetLineId'], where, _count: { _all: true as const } };
  const groups = await Promise.all([
    prisma.expenseClaim.groupBy(by),
    prisma.supplierBill.groupBy(by),
    prisma.budgetRequest.groupBy(by),
    prisma.cashAdvance.groupBy(by),
  ]);
  for (const g of groups.flat()) if (g.officeBudgetLineId) out.set(g.officeBudgetLineId, (out.get(g.officeBudgetLineId) ?? 0) + g._count._all);
  return out;
}

/** The two budgets the owner sent (Builk, 2026), with what each line had spent — `seedOfficeBudgets()`. */
export const OFFICE_BUDGETS_2026: { name: string; lines: [code: string, name: string, budget: number, actual: number][] }[] = [
  {
    name: '2026 GRUNTECH YEARLY BUDGET',
    lines: [
      ['201', 'OFFICE EXPENSE', 180000, 211690.96],
      ['202', 'OFFICE SUPPLIES', 157764, 117004.84],
      ['203', 'OFFICE FURNITURE, RENOVATION AND MAINTENANCE', 713000, 383226.64],
      ['204', 'RENT & LEASE PAYMENT', 4139814.72, 0],
      ['205', 'MEAL AND ENTERTAINMENT', 99999.96, 113157.53],
      ['206', 'REPRESENTATION PRINCIPAL', 399999.96, 204293.32],
      ['207', 'UTILITIES (MERALCO, WATER)', 831600, 485772.74],
      ['208', 'INTERNET / TELEPHONE', 176327.76, 29203],
      ['209', 'SUBSCRIPTION (ODOO, GMAIL, & QB)', 972000, 522842.16],
      ['210', 'STATIONARY PRINTING', 38499.96, 38499],
      ['211', 'TAXES AND LICENSES', 566500, 239034.43],
      ['212', 'LEGAL AND PROFESSIONAL FEE', 600000, 0],
      ['213', 'TRAINING AND SEMINAR', 500000, 73567.95],
      ['214', 'TRAVEL EXPENSE', 500000, 35207.36],
      ['215', 'UNIFORM AND PPE', 100500, 400],
      ['216', 'MARKETING EXPENSE', 900000, 469753.99],
      ['217', 'CEO FUND', 1000000, 140815],
      ['218', 'GRUNTECH ACADEMY', 100000, 0],
    ],
  },
  {
    name: '2026 GRUNTECHLIFE BUDGET',
    lines: [
      ['101', 'TEAM BUILDING', 0, 0],
      ['102', 'BUSINESS MEETING ANNUAL', 0, 0],
      ['103', 'SUMMER OUTING', 600000, 596802],
      ['104', 'BUSINESS MEETING - Q1', 100000, 39794.59],
      ['105', 'GRUNTECHNOLOGY ANNIVERSARY', 600000, 593802],
      ['106', 'BUSINESS MEETING - Q2', 150000, 100962.22],
      ['107', 'CHRISTMAS PARTY', 1300000, 25000],
      ['108', 'MONTHLY ACTIVITY', 120000, 120000],
      ['109', 'BUSINESS MEETING - Q3', 100000, 0],
      ['110', 'WORK ANNIVERSARY', 202000, 134807.3],
      ['111', 'BIRTHDAY CELEBRATION', 186000, 107202],
      ['112', 'GRUNTECHCARE', 100000, 0],
      ['113', 'GRUNTECH CULTURE AWARD', 0, 0],
      ['114', 'MARKETING', 0, 0],
      ['115', 'FRIDAY MEETING COFFEE', 48000, 1903],
      ['116', 'CHRISTMAS DECOR', 20000, 0],
      ['117', 'BASKETBALL - MEALS', 0, 0],
      ['118', 'MISC.', 0, 0],
      ['119', 'EARLY BIRD COFFEE', 57600, 0],
      ['120', 'CTG BIRTHDAY', 40000, 40000],
    ],
  },
];

/** The seed, once (`seed.officeBudgets2026`): the owner's two budgets, where no budget of that name stands. */
export async function seedOfficeBudgets(): Promise<number> {
  const MARK = 'seed.officeBudgets2026';
  if (await prisma.setting.findUnique({ where: { key: MARK } })) return 0;
  let made = 0;
  for (const b of OFFICE_BUDGETS_2026) {
    const there = await prisma.officeBudget.findFirst({ where: { year: 2026, name: b.name } });
    if (there) continue;
    await prisma.officeBudget.create({
      data: {
        year: 2026,
        name: b.name,
        notes: 'Brought over from the Builk budget monitor; each line’s opening actual is what Builk had spent.',
        lines: { create: b.lines.map(([code, name, amount, actual], i) => ({ code, name, amount, openingActual: actual, sortOrder: i })) },
      },
    });
    made++;
  }
  await prisma.setting.create({ data: { key: MARK, value: { at: new Date().toISOString(), made } } });
  return made;
}
