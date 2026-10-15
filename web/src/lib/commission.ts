/**
 * THE WEB COPY of `api/src/shared/commission.ts` — pinned equal by verify-finance.
 *
 * COMMISSION ARITHMETIC (2026-10-16, the owner's "Commission Request System").
 * Pure, exact in centavos (BigInt), every rounding half away from zero.
 * `web/src/lib/commission.ts` is a COPY for the editor's live figures, pinned
 * equal by verify-finance — change both.
 *
 *   net of VAT        = total − VAT
 *   actual margin     = collected − VAT − total cost      (the owner's banner)
 *   gross commission  = max(0, margin) × rate
 *   a share           = gross × share %   (the remainder on the largest share,
 *                                          so the shares add up to the gross)
 *   tax               = share × tax %     (10% by default)
 *   net               = share − tax − cash advance deduction
 */

export interface CommissionShareInput {
  /** A fraction: 0.6 = 60%. */
  sharePct: number;
  /** A fraction: 0.1 = 10%. */
  taxPct: number;
  /** Pesos, repaying the beneficiary's cash advance. */
  caDeduction: number;
}

export interface CommissionInput {
  totalAmount: number;
  vatAmount: number;
  totalCost: number;
  collectedAmount: number;
  /** A fraction: 0.1 = 10%. */
  ratePct: number;
  shares: CommissionShareInput[];
}

export interface CommissionFigures {
  netOfVat: number;
  margin: number;
  grossCommission: number;
  shares: { share: number; tax: number; caDeduction: number; net: number }[];
  totalShare: number;
  totalTax: number;
  totalCa: number;
  totalNet: number;
  /** The shares' percentages add up to 100% (to the millionth). */
  sharesComplete: boolean;
}

const MICRO = 1_000_000n;

/** Pesos to whole centavos, half away from zero. */
export function toCents(v: number): bigint {
  const n = Math.round(Math.abs(v) * 100 + 1e-7);
  return BigInt(v < 0 ? -n : n);
}
const toMicro = (f: number): bigint => {
  const n = Math.round(Math.abs(f) * 1e6);
  return BigInt(f < 0 ? -n : n);
};
const pesos = (c: bigint) => Number(c) / 100;

/** cents × fraction (in millionths), half away from zero. */
function mulRate(cents: bigint, micro: bigint): bigint {
  const p = cents * micro;
  const neg = p < 0n;
  const a = neg ? -p : p;
  const q = (a + MICRO / 2n) / MICRO;
  return neg ? -q : q;
}

export function commissionFigures(input: CommissionInput): CommissionFigures {
  const total = toCents(input.totalAmount);
  const vat = toCents(input.vatAmount);
  const cost = toCents(input.totalCost);
  const collected = toCents(input.collectedAmount);
  const net = total - vat;
  const margin = collected - vat - cost;
  const gross = margin > 0n ? mulRate(margin, toMicro(input.ratePct)) : 0n;

  const micros = input.shares.map((s) => toMicro(s.sharePct));
  const sumMicro = micros.reduce((a, b) => a + b, 0n);
  const raw = micros.map((m) => mulRate(gross, m));
  // The remainder goes on the largest share, so the shares add up to the gross.
  if (raw.length && sumMicro === MICRO) {
    const diff = gross - raw.reduce((a, b) => a + b, 0n);
    let big = 0;
    for (let i = 1; i < raw.length; i++) if (raw[i] > raw[big]) big = i;
    raw[big] += diff;
  }
  const shares = input.shares.map((s, i) => {
    const share = raw[i];
    const tax = mulRate(share, toMicro(s.taxPct));
    const ca = toCents(s.caDeduction);
    return { share: pesos(share), tax: pesos(tax), caDeduction: pesos(ca), net: pesos(share - tax - ca) };
  });
  const sum = (k: 'share' | 'tax' | 'caDeduction' | 'net') => pesos(shares.reduce((a, s) => a + toCents(s[k]), 0n));
  return {
    netOfVat: pesos(net),
    margin: pesos(margin),
    grossCommission: pesos(gross),
    shares,
    totalShare: sum('share'),
    totalTax: sum('tax'),
    totalCa: sum('caDeduction'),
    totalNet: sum('net'),
    sharesComplete: sumMicro === MICRO,
  };
}
