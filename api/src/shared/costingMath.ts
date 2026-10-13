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
  /**
   * The gross margin on the contract value, as a fraction to six decimals
   * (0.25 = 25% of the price). Replaced the markup on cost on 2026-10-09 (the
   * owner's call): contract value = cost ÷ (1 − margin), so a 25% margin on a
   * 75,000 cost prices the job at 100,000.
   */
  marginPct: Num;
  vatRate?: Num;
  /**
   * A FIXED PRICE (2026-10-13, the owner's call: "the percentage is hard to
   * hit the desired value"): the contract value, net of VAT, as typed. When
   * set, the contract value IS it, to the centavo, and the margin is what it
   * amounts to over the cost — a line changed afterwards keeps the price and
   * moves the margin, as a fixed-price bid does. Null or 0: priced from
   * `marginPct`.
   */
  targetContractValue?: Num;
}

export interface CostingFigures {
  /** The project budgeted cost: every line, direct and indirect — the Contingency bucket included. */
  totalCost: number;
  /** What the margin adds on top of the cost: contract value − cost. */
  marginAmount: number;
  /** Net of VAT — what the schedule of values adds up to and billing bills. */
  contractValue: number;
  vatAmount: number;
  grandTotal: number;
  grossProfit: number;
  /** Profit over the contract value, never over cost. */
  grossMarginPct: number;
  /** The margin the price stands on, to six decimals: the rate given, or — at a fixed price — what the price amounts to. */
  marginPct: number;
  /** Priced from `targetContractValue`. */
  fixedPrice: boolean;
}

const TENK = BigInt(10000);
const MILLION = BigInt(1_000_000);

/**
 * The cost summary, top to bottom:
 *
 *   project budgeted cost   Σ line amounts (a subheading costs nothing)
 *   = contract value        cost ÷ (1 − margin), rounded once to the centavo;
 *                           net of VAT — or, at a fixed price, the price as
 *                           typed, the margin then derived from it. A margin of 100% or more is no price
 *                           at all, so it prices at cost — the API refuses it
 *                           long before (±95% is the limit).
 *   + VAT                   contract value × VAT rate
 *   = grand total
 *
 * There is no contingency % and no discount any more (2026-10-09): a
 * contingency is a cost LINE in its own bucket, and a discount is the
 * quotation's business.
 */
export function costingFigures(lines: MathLine[], rates: CostingRates): CostingFigures {
  let total = ZERO;
  for (const l of lines) if (!l.isHeading) total += lineAmountCents(l.quantity, l.unitCost);
  const target = toUnits(rates.targetContractValue, 2);
  const fixedPrice = target > ZERO;
  const denominator = MILLION - toUnits(rates.marginPct, 6);
  const contract = fixedPrice ? target : denominator > ZERO ? roundDiv(total * MILLION, denominator) : total;
  const marginUnits = fixedPrice ? roundDiv((contract - total) * MILLION, contract) : toUnits(rates.marginPct, 6);
  const vat = roundDiv(contract * toUnits(rates.vatRate, 4), TENK);
  const profit = contract - total;
  return {
    totalCost: cents(total),
    marginAmount: cents(profit),
    contractValue: cents(contract),
    vatAmount: cents(vat),
    grandTotal: cents(contract + vat),
    grossProfit: cents(profit),
    grossMarginPct: contract > ZERO ? Number(profit) / Number(contract) : 0,
    marginPct: Number(marginUnits) / 1_000_000,
    fixedPrice,
  };
}

/** VAT on an amount, rounded once to the centavo — the summary's VAT on a STORED contract value. */
export function vatOn(amount: Num, vatRate: Num): number {
  return cents(roundDiv(toUnits(amount, 2) * toUnits(vatRate, 4), TENK));
}

/** The margin a markup on cost amounts to: 25% on cost is a 20% margin on the price. */
export function marginOfMarkup(markupPct: number): number {
  return markupPct > -1 ? Math.round((markupPct / (1 + markupPct)) * 1_000_000) / 1_000_000 : 0;
}

// ── The schedule of values ───────────────────────────────────────────────────

export type ValueSource = 'SPREAD' | 'DECLARED' | 'CATEGORY';

export interface SovSection {
  valueSource: ValueSource;
  /** What is on the phase now: typed (DECLARED), or the last spread (SPREAD). */
  value: Num;
  /** CATEGORY: the cost buckets whose cost, priced like the sheet, is the phase's value. */
  costCategoryIds?: string[];
}

export interface SovResult {
  values: number[];
  /** The contract value less what the declared and cost-priced phases take. */
  remaining: number;
  /** Why the phases cannot add up to the contract value, or null. */
  problem: 'over' | 'unbalanced' | null;
}

/**
 * The schedule of values (2026-10-13, the owner's call: "the scope of work
 * value editable to declare the value; the materials cost is allocated to
 * purchasing of materials, the equipment cost to purchasing of equipment").
 *
 *   DECLARED   the value typed, kept as typed.
 *   CATEGORY   the named buckets' cost priced as the sheet prices its cost:
 *              cost × contract value ÷ total cost, rounded once — so the
 *              buckets together come to the contract value.
 *   SPREAD     with `spread` on, what the others leave, spread in proportion
 *              to what the SPREAD phases hold (evenly when nothing), the
 *              remainder on the last of them; with it off, the value typed.
 *
 * With `spread` on the phases add up to the contract value exactly: a
 * centavo or two of rounding with no SPREAD phase lands on the last
 * cost-priced one. More declared than the contract holds is `over`; any
 * other gap left with no phase to take it is `unbalanced`.
 */
export function scheduleOfValues(
  sections: SovSection[],
  bucketCost: Record<string, Num>,
  contractValue: Num,
  totalCost: Num,
  spread: boolean,
): SovResult {
  const contract = toUnits(contractValue, 2);
  const total = toUnits(totalCost, 2);
  const values = sections.map((sec) => {
    if (sec.valueSource === 'CATEGORY') {
      if (total <= ZERO) return ZERO;
      let cost = ZERO;
      for (const id of sec.costCategoryIds ?? []) cost += toUnits(bucketCost[id], 2);
      return roundDiv(cost * contract, total);
    }
    return toUnits(sec.value, 2);
  });
  const isSpread = (i: number) => spread && sections[i].valueSource === 'SPREAD';
  let fixed = ZERO;
  values.forEach((v, i) => {
    if (!isSpread(i)) fixed += v;
  });
  const rest = contract - fixed;
  let problem: SovResult['problem'] = null;
  if (spread) {
    const spreadIdx = sections.map((_, i) => i).filter(isSpread);
    if (rest < ZERO) {
      problem = 'over';
      for (const i of spreadIdx) values[i] = ZERO;
    } else if (spreadIdx.length) {
      const held = spreadIdx.reduce((n, i) => n + (values[i] > ZERO ? values[i] : ZERO), ZERO);
      let given = ZERO;
      spreadIdx.forEach((i, k) => {
        if (k === spreadIdx.length - 1) {
          values[i] = rest - given;
        } else {
          const share = held > ZERO ? roundDiv((values[i] > ZERO ? values[i] : ZERO) * rest, held) : roundDiv(rest, BigInt(spreadIdx.length));
          values[i] = share;
          given += share;
        }
      });
    } else if (rest !== ZERO) {
      const fromCost = sections.map((_, i) => i).filter((i) => sections[i].valueSource === 'CATEGORY');
      const drift = rest < ZERO ? -rest : rest;
      if (fromCost.length && drift <= BigInt(fromCost.length)) values[fromCost[fromCost.length - 1]] += rest;
      else problem = 'unbalanced';
    }
  }
  const sum = values.reduce((n, v) => n + v, ZERO);
  return { values: values.map(cents), remaining: cents(contract - sum), problem };
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
  /** First and last working day of the phase: its tasks' span, or its own typed duration in the sequence; null with nothing planned. */
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
 * how a milestone prints. A phase with no tasks but a typed duration takes
 * its place in the same sequence (2026-10-09): it is a bar on the Gantt chart
 * like any other, and the plan lasts through it.
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
    if (!tasks.length) {
      const days = Math.max(0, Math.floor(s.durationDays || 0));
      if (!days) return { tasks, start: null, end: null, days: 0 };
      const start = cursor;
      const end = start + days - 1;
      cursor = end + 1;
      total = Math.max(total, end);
      return { tasks, start, end, days };
    }
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
