/**
 * The quotation editor's live figures — a MIRROR of `quotationTotals` and
 * `lineAmount` in api/src/shared/quotation.ts, not a second rule.
 *
 * The server does the arithmetic in Prisma's Decimal (decimal.js at 20
 * significant digits, ROUND_HALF_UP, rounding to the centavo at each named
 * step). A float version would disagree with it by a centavo on the odd line,
 * and the page would show one total while the saved quotation stored another.
 * So this reproduces the same steps in exact fixed-point (BigInt), rounding
 * every intermediate result to 20 significant digits exactly as decimal.js
 * does, and returns the same shape.
 *
 * `api/scripts/verify-sales.ts` runs this and the server function on the same
 * inputs and asserts the results are identical. Change the server's rule and
 * that check fails until this file follows it.
 *
 * DOM-free and dependency-free on purpose: the verify script imports it, the
 * way verify-calendar imports lib/day.ts.
 */

type Money = number | string | null | undefined;

// ── A minimal exact decimal: value = n / 10^s ───────────────────────────────

interface Dec {
  n: bigint;
  s: number;
}

const PRECISION = 20;
const TEN = BigInt(10);
const ZERO_N = BigInt(0);
const ONE_N = BigInt(1);
const TWO_N = BigInt(2);

const pow10 = (k: number) => TEN ** BigInt(k);
const abs = (v: bigint) => (v < ZERO_N ? -v : v);
const digits = (v: bigint) => abs(v).toString().length;

function dec(n: bigint, s: number): Dec {
  return s < 0 ? { n: n * pow10(-s), s: 0 } : { n, s };
}

/** As `new Prisma.Decimal(v)`: a number goes through its own string form. */
function D(v: Money): Dec {
  if (v === null || v === undefined || v === '') return { n: ZERO_N, s: 0 };
  const str = String(v).trim().toLowerCase();
  const m = /^([+-]?)(\d*)(?:\.(\d*))?(?:e([+-]?\d+))?$/.exec(str);
  if (!m || (m[2] === '' && (m[3] ?? '') === '')) throw new Error(`Not a number: ${String(v)}`);
  const frac = m[3] ?? '';
  const exp = m[4] ? Number(m[4]) : 0;
  const n = BigInt(`${m[2] || '0'}${frac}`) * (m[1] === '-' ? -ONE_N : ONE_N);
  return dec(n, frac.length - exp);
}

/** Drops `drop` trailing digits of |n|, rounding half away from zero. */
function dropDigits(n: bigint, drop: number): bigint {
  if (drop <= 0) return n;
  const base = pow10(drop);
  const a = abs(n);
  let q = a / base;
  if (TWO_N * (a % base) >= base) q += ONE_N;
  return n < ZERO_N ? -q : q;
}

/** decimal.js rounds every operation's result to `precision` significant digits. */
function sig(x: Dec): Dec {
  const extra = digits(x.n) - PRECISION;
  if (extra <= 0) return x;
  return dec(dropDigits(x.n, extra), x.s - extra);
}

function align(a: Dec, b: Dec): [bigint, bigint, number] {
  const s = Math.max(a.s, b.s);
  return [a.n * pow10(s - a.s), b.n * pow10(s - b.s), s];
}

const add = (a: Dec, b: Dec): Dec => {
  const [x, y, s] = align(a, b);
  return sig({ n: x + y, s });
};
const sub = (a: Dec, b: Dec): Dec => {
  const [x, y, s] = align(a, b);
  return sig({ n: x - y, s });
};
const mul = (a: Dec, b: Dec): Dec => sig({ n: a.n * b.n, s: a.s + b.s });

/**
 * Correctly rounded division to 20 significant digits. The quotient is taken
 * with at least 23 digits and then rounded once: the half-way test compares
 * the dropped digits against an integer threshold, so truncating first cannot
 * change the decision.
 */
function div(a: Dec, b: Dec): Dec {
  if (b.n === ZERO_N) throw new Error('Division by zero');
  if (a.n === ZERO_N) return { n: ZERO_N, s: 0 };
  const N = abs(a.n) * pow10(b.s);
  const M = abs(b.n) * pow10(a.s);
  const k = Math.max(0, PRECISION + 3 + digits(M) - digits(N));
  const t = (N * pow10(k)) / M;
  const negative = a.n < ZERO_N !== b.n < ZERO_N;
  return sig({ n: negative ? -t : t, s: k });
}

const isZero = (a: Dec) => a.n === ZERO_N;
const cmp = (a: Dec, b: Dec) => {
  const [x, y] = align(a, b);
  return x === y ? 0 : x < y ? -1 : 1;
};

/** toDecimalPlaces(dp, ROUND_HALF_UP). */
function toDP(a: Dec, dp: number): Dec {
  return a.s <= dp ? a : { n: dropDigits(a.n, a.s - dp), s: dp };
}

/** toFixed(dp), then Number() — what the server sends. */
function fixed(a: Dec, dp: number): number {
  const r = toDP(a, dp);
  const n = r.n * pow10(dp - r.s);
  const neg = n < ZERO_N;
  const str = abs(n).toString().padStart(dp + 1, '0');
  const whole = str.slice(0, str.length - dp);
  const part = dp > 0 ? `.${str.slice(str.length - dp)}` : '';
  return Number(`${neg ? '-' : ''}${whole}${part}`);
}

const r2 = (v: Dec) => toDP(v, 2);
const out = (v: Dec) => fixed(v, 2);
const pctOf = (part: Dec, base: Dec) => (isZero(base) ? null : fixed(toDP(mul(div(part, base), D(100)), 1), 1));

// ── The mirror ──────────────────────────────────────────────────────────────

export interface QuotationLineMoney {
  amount: Money;
  costAmount?: Money;
  providerUserId?: string | null;
  providerSupplierId?: string | null;
  /** A subheading: no money, and not a line the cost panel counts. */
  isHeading?: boolean | null;
}

export interface QuotationTotalsInput {
  lines: QuotationLineMoney[];
  discountPct?: Money;
  vatRate: Money;
  vatInclusive?: boolean;
}

export interface LineMargin {
  amount: number;
  costAmount: number | null;
  margin: number | null;
  marginPct: number | null;
  kind: 'inHouse' | 'outsourced' | 'unassigned';
}

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

export interface QuotationTotals {
  subtotal: number;
  discountPct: number;
  discountAmount: number;
  net: number;
  vatRate: number;
  vatInclusive: boolean;
  vatAmount: number;
  total: number;
  netOfTax: number;
  cost: CostPanel;
  lines: LineMargin[];
}

/** A line's amount: quantity × price, to the centavo — as the server stores it. */
export function lineAmount(quantity: Money, unitPrice: Money): number {
  return out(r2(mul(D(quantity), D(unitPrice))));
}

function lineKind(l: QuotationLineMoney): LineMargin['kind'] {
  if (l.providerUserId) return 'inHouse';
  if (l.providerSupplierId) return 'outsourced';
  return 'unassigned';
}

/** Step for step, `quotationTotals` in api/src/shared/quotation.ts. */
export function quotationTotals(input: QuotationTotalsInput): QuotationTotals {
  const zero = (): Dec => ({ n: ZERO_N, s: 0 });
  const rate = D(input.vatRate);
  const rawPct = D(input.discountPct);
  const hundred = D(100);
  const pct = cmp(rawPct, zero()) < 0 ? zero() : cmp(rawPct, hundred) > 0 ? hundred : rawPct;
  const inclusive = !!input.vatInclusive;

  const amounts = input.lines.map((l) => r2(D(l.amount)));
  const subtotal = amounts.reduce((s, a) => add(s, a), zero());
  const discountAmount = r2(div(mul(subtotal, pct), hundred));
  const net = sub(subtotal, discountAmount);
  const vatAmount = inclusive ? r2(sub(net, div(net, add(rate, D(1))))) : r2(mul(net, rate));
  const total = inclusive ? net : add(net, vatAmount);
  const netOfTax = inclusive ? sub(net, vatAmount) : net;

  const factor = isZero(subtotal) ? zero() : div(netOfTax, subtotal);

  const cost = { inHouse: zero(), outsourced: zero(), unassigned: zero() };
  const revenue = { inHouse: zero(), outsourced: zero(), unassigned: zero() };
  let costedLines = 0;

  const lines: LineMargin[] = input.lines.map((l, i) => {
    const kind = lineKind(l);
    const amount = amounts[i];
    const hasCost = l.costAmount !== null && l.costAmount !== undefined && l.costAmount !== '';
    const c = hasCost ? r2(D(l.costAmount)) : null;
    if (c) costedLines++;
    cost[kind] = add(cost[kind], c ?? zero());
    revenue[kind] = add(revenue[kind], amount);
    const margin = c ? sub(amount, c) : null;
    return {
      amount: out(amount),
      costAmount: c ? out(c) : null,
      margin: margin ? out(margin) : null,
      marginPct: margin ? pctOf(margin, amount) : null,
      kind,
    };
  });

  const totalCost = add(add(cost.inHouse, cost.outsourced), cost.unassigned);
  const totalMargin = sub(netOfTax, totalCost);
  const inHouseMargin = sub(r2(mul(revenue.inHouse, factor)), cost.inHouse);
  const outsourcedMargin = sub(r2(mul(revenue.outsourced, factor)), cost.outsourced);
  const unassignedMargin = sub(sub(totalMargin, inHouseMargin), outsourcedMargin);

  return {
    subtotal: out(subtotal),
    discountPct: fixed(pct, 6),
    discountAmount: out(discountAmount),
    net: out(net),
    vatRate: Number(String(input.vatRate ?? 0) || 0),
    vatInclusive: inclusive,
    vatAmount: out(vatAmount),
    total: out(total),
    netOfTax: out(netOfTax),
    cost: {
      totalCost: out(totalCost),
      inHouseCost: out(cost.inHouse),
      outsourcedCost: out(cost.outsourced),
      unassignedCost: out(cost.unassigned),
      totalMargin: out(totalMargin),
      inHouseMargin: out(inHouseMargin),
      outsourcedMargin: out(outsourcedMargin),
      unassignedMargin: out(unassignedMargin),
      totalCostPct: pctOf(totalCost, netOfTax),
      inHouseCostPct: pctOf(cost.inHouse, netOfTax),
      outsourcedCostPct: pctOf(cost.outsourced, netOfTax),
      totalMarginPct: pctOf(totalMargin, netOfTax),
      inHouseMarginPct: pctOf(inHouseMargin, netOfTax),
      outsourcedMarginPct: pctOf(outsourcedMargin, netOfTax),
      costedLines,
      lineCount: input.lines.filter((l) => !l.isHeading).length,
    },
    lines,
  };
}
