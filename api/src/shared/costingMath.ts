/**
 * The costing's arithmetic, in one place: line amounts, the cost summary and
 * the scope-of-work plan.
 *
 * Exact, in integers. A quantity carries three decimals and a unit cost two
 * (their columns), so a line amount is (quantity × 1000) × (cost × 100),
 * divided back down and rounded half away from zero to the centavo — in
 * BigInt, because that product outruns a float's 53 bits long before it
 * outruns a contractor's budget. The rates carry four decimals (Decimal(7,4)
 * and (6,4)), so each rate step is the same: multiply, divide by 10,000, round
 * once. A float version disagrees by a centavo on the odd sheet, and the page
 * would show one total while the saved costing stored another.
 *
 * `web/src/lib/costingMath.ts` is a copy of this file for the editor's live
 * figures; `api/scripts/verify-costing.ts` runs both on the same inputs and
 * asserts they agree. Change the rule here and that check fails until the copy
 * follows.
 *
 * No imports, no Prisma, no DOM: both sides and the verify script load it.
 */

type Num = number | string | null | undefined;

const ZERO = BigInt(0);
const ONE = BigInt(1);
const TWO = BigInt(2);
const TEN = BigInt(10);

/** `v` as an integer count of 10^-scale, rounded half away from zero. */
export function toUnits(v: Num, scale: number): bigint {
  if (v === null || v === undefined || v === '') return ZERO;
  const str = String(v).trim().toLowerCase();
  const m = /^([+-]?)(\d*)(?:\.(\d*))?(?:e([+-]?\d+))?$/.exec(str);
  if (!m || (m[2] === '' && (m[3] ?? '') === '')) return ZERO;
  const frac = m[3] ?? '';
  const exp = m[4] ? Number(m[4]) : 0;
  let n = BigInt(`${m[2] || '0'}${frac}`);
  // n is the value × 10^(frac.length − exp); bring it to × 10^scale.
  const shift = scale - (frac.length - exp);
  if (shift >= 0) n *= TEN ** BigInt(shift);
  else n = roundDiv(n, TEN ** BigInt(-shift));
  return m[1] === '-' ? -n : n;
}

/** a ÷ b for positive b, rounded half away from zero. */
function roundDiv(a: bigint, b: bigint): bigint {
  const neg = a < ZERO;
  const x = neg ? -a : a;
  let q = x / b;
  if (TWO * (x % b) >= b) q += ONE;
  return neg ? -q : q;
}

const cents = (v: bigint) => Number(v) / 100;

/** quantity × unit cost, to the centavo. */
export function lineAmountCents(quantity: Num, unitCost: Num): bigint {
  return roundDiv(toUnits(quantity, 3) * toUnits(unitCost, 2), BigInt(1000));
}

export function lineAmount(quantity: Num, unitCost: Num): number {
  return cents(lineAmountCents(quantity, unitCost));
}

export interface MathLine {
  quantity: Num;
  unitCost: Num;
  isHeading?: boolean;
}

export interface CostingRates {
  /** Markup on the project budgeted cost, as a fraction (0.2 = 20%). */
  markupPct: Num;
  contingencyPct?: Num;
  discountAmount?: Num;
  vatRate?: Num;
}

export interface CostingFigures {
  /** The project budgeted cost: every line, direct and indirect. */
  totalCost: number;
  markupAmount: number;
  contingencyAmount: number;
  discountAmount: number;
  /** Net of VAT — what the schedule of values adds up to and billing bills. */
  contractValue: number;
  vatAmount: number;
  grandTotal: number;
  grossProfit: number;
  /** Profit over the contract value, never over cost. */
  grossMarginPct: number;
}

/**
 * The cost summary, top to bottom:
 *
 *   project budgeted cost   Σ line amounts (a subheading costs nothing)
 *   + markup                cost × markup %
 *   + contingency           cost × contingency %
 *   − discount
 *   = contract value        never below zero; net of VAT
 *   + VAT                   contract value × VAT rate
 *   = grand total
 */
export function costingFigures(lines: MathLine[], rates: CostingRates): CostingFigures {
  let total = ZERO;
  for (const l of lines) if (!l.isHeading) total += lineAmountCents(l.quantity, l.unitCost);
  const TENK = BigInt(10000);
  const markup = roundDiv(total * toUnits(rates.markupPct, 4), TENK);
  const contingency = roundDiv(total * toUnits(rates.contingencyPct, 4), TENK);
  const discount = toUnits(rates.discountAmount, 2);
  let contract = total + markup + contingency - discount;
  if (contract < ZERO) contract = ZERO;
  const vat = roundDiv(contract * toUnits(rates.vatRate, 4), TENK);
  const profit = contract - total;
  return {
    totalCost: cents(total),
    markupAmount: cents(markup),
    contingencyAmount: cents(contingency),
    discountAmount: cents(discount),
    contractValue: cents(contract),
    vatAmount: cents(vat),
    grandTotal: cents(contract + vat),
    grossProfit: cents(profit),
    grossMarginPct: contract > ZERO ? Number(profit) / Number(contract) : 0,
  };
}

// ── The scope-of-work plan ───────────────────────────────────────────────────

export interface PlanTask {
  startDay?: number | null;
  durationDays: number;
}

export interface PlannedTask {
  start: number;
  end: number;
  days: number;
}

export interface PlannedSection {
  tasks: PlannedTask[];
  /** First and last working day of the phase's tasks; null with no tasks. */
  start: number | null;
  end: number | null;
  /** Working days the phase spans, or its own duration when it has no tasks. */
  days: number;
}

/**
 * Where every task falls, in working days (Mon–Fri, day 1 = the first).
 *
 * A task with a start day keeps it. One without follows the task before it —
 * the day after that one ends — so a plan typed as a plain list of durations
 * reads as a sequence, and "Sequence tasks" on the page only has to write
 * these numbers down. A zero-day task still occupies its start day, which is
 * how a milestone prints.
 */
export function planTasks(
  sections: { durationDays: number; tasks: PlanTask[] }[],
): { sections: PlannedSection[]; totalDays: number } {
  let cursor = 1;
  let total = 0;
  const planned = sections.map((s) => {
    const tasks = s.tasks.map((t) => {
      const start = t.startDay && t.startDay > 0 ? Math.floor(t.startDay) : cursor;
      const days = Math.max(0, Math.floor(t.durationDays || 0));
      const end = start + Math.max(days, 1) - 1;
      cursor = end + 1;
      total = Math.max(total, end);
      return { start, end, days };
    });
    if (!tasks.length) return { tasks, start: null, end: null, days: Math.max(0, s.durationDays || 0) };
    const start = Math.min(...tasks.map((t) => t.start));
    const end = Math.max(...tasks.map((t) => t.end));
    return { tasks, start, end, days: end - start + 1 };
  });
  return { sections: planned, totalDays: total };
}

/**
 * The line codes the sheet prints: 101, 102 … under the first category, 201 …
 * under the second, counting cost lines only (a subheading has no code).
 * Derived from position, never stored, so reordering a sheet renumbers it.
 */
export function lineCodes(lines: { rank: number; isHeading?: boolean }[]): (string | null)[] {
  const seen = new Map<number, number>();
  return lines.map((l) => {
    if (l.isHeading) return null;
    const n = (seen.get(l.rank) ?? 0) + 1;
    seen.set(l.rank, n);
    // Past 99 lines a category keeps its own prefix rather than running into the next hundred.
    return n < 100 ? String(l.rank * 100 + n) : `${l.rank}${n}`;
  });
}
