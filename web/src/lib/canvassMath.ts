/**
 * WEB COPY of api/src/shared/canvassMath.ts — pinned equal by verify-foundation; change both.
 *
 * The canvass sheet's arithmetic (2026-10-14, the owner's call: "add a row
 * for Percentage Savings — the reference budget is the approved purchase
 * request, and the total at the bottom"). Pure, so verify-chain pins it and
 * the page, the list and the paper all read one rule.
 *
 * Per supplier column: `total` = Σ quantity × unit price over the lines it
 * quoted; `budgetOnQuoted` = Σ the request's estimated amount over the SAME
 * lines; `savings` = budgetOnQuoted − total; `savingsPct` = savings ÷
 * budgetOnQuoted to two decimals (null when nothing was quoted or the
 * estimate is nil). A supplier that quoted every line is `complete`; a
 * partial one's saving is measured on the lines it quoted only, and says so,
 * so a cheap partial quote never reads as the best. Everything is summed in
 * whole centavos.
 */

export interface SheetLine {
  id: string;
  quantity: number;
  estimatedCost: number;
  /** The request's own estimated amount for the line, as stored. */
  estimatedAmount: number;
}

export interface SheetColumn {
  id: string;
  /** Unit price by request line id; a line not in it was not quoted. */
  prices: Record<string, number>;
}

export interface ColumnFigures {
  id: string;
  /** Line amount by request line id, for the lines quoted. */
  amounts: Record<string, number>;
  total: number;
  budgetOnQuoted: number;
  savings: number;
  savingsPct: number | null;
  quotedCount: number;
  complete: boolean;
}

export interface SheetFigures {
  /** The reference budget: the request's estimate over the sheet's lines. */
  budget: number;
  columns: ColumnFigures[];
  /** The lowest total among complete quotes (the first on a tie), else null. */
  lowestCompleteId: string | null;
}

const toCents = (v: number) => Math.round(v * 100);

/** quantity × unit price in centavos, rounded half away from zero (quantity to 3 dp, price to 2). */
export function lineAmountCents(quantity: number, unitPrice: number): number {
  const milli = Math.round(quantity * 1000);
  const price = toCents(unitPrice);
  const raw = milli * price;
  return Math.sign(raw) * Math.round(Math.abs(raw) / 1000);
}

export function canvassFigures(lines: SheetLine[], columns: SheetColumn[]): SheetFigures {
  const budgetCents = lines.reduce((s, l) => s + toCents(l.estimatedAmount), 0);
  const figures = columns.map((c): ColumnFigures => {
    let total = 0;
    let budget = 0;
    let quoted = 0;
    const amounts: Record<string, number> = {};
    for (const l of lines) {
      const price = c.prices[l.id];
      if (price === undefined || price === null || !Number.isFinite(price)) continue;
      const amount = lineAmountCents(l.quantity, price);
      amounts[l.id] = amount / 100;
      total += amount;
      budget += toCents(l.estimatedAmount);
      quoted++;
    }
    const savings = budget - total;
    return {
      id: c.id,
      amounts,
      total: total / 100,
      budgetOnQuoted: budget / 100,
      savings: savings / 100,
      savingsPct: quoted && budget ? Math.round((savings / budget) * 10_000) / 100 : null,
      quotedCount: quoted,
      complete: lines.length > 0 && quoted === lines.length,
    };
  });
  const complete = figures.filter((f) => f.complete && f.total > 0);
  const lowest = complete.reduce<ColumnFigures | null>((best, f) => (!best || f.total < best.total ? f : best), null);
  return { budget: budgetCents / 100, columns: figures, lowestCompleteId: lowest?.id ?? null };
}

/** At most six suppliers on one sheet: the paper sets three to a table, two tables at most. */
export const MAX_SHEET_SUPPLIERS = 6;

/**
 * The award, line by line (2026-11-04, the owner's call: "a purchase request
 * is a bundle of materials bought from different suppliers"). `picks` gives
 * each request line the column that wins it (missing or null: not awarded —
 * bought later). A winner's figures are taken over ITS lines only: its total
 * at its own prices, the reference budget of those lines, the saving; the
 * award's figures are their sums. A pick on a column that did not quote the
 * line counts for nothing (the route refuses it before).
 */
export interface AwardWinner {
  id: string;
  lineIds: string[];
  total: number;
  budget: number;
  savings: number;
  savingsPct: number | null;
}

export interface AwardSummary {
  winners: AwardWinner[];
  total: number;
  budget: number;
  savings: number;
  savingsPct: number | null;
  /** The lines no supplier was awarded, in the sheet's order. */
  notAwarded: string[];
}

export function awardSummary(lines: SheetLine[], columns: SheetColumn[], picks: Record<string, string | null | undefined>): AwardSummary {
  const by = new Map<string, { lineIds: string[]; total: number; budget: number }>();
  const notAwarded: string[] = [];
  let total = 0;
  let budget = 0;
  for (const l of lines) {
    const col = columns.find((c) => c.id === picks[l.id]);
    const price = col?.prices[l.id];
    if (!col || price === undefined || price === null || !Number.isFinite(price)) {
      notAwarded.push(l.id);
      continue;
    }
    const amount = lineAmountCents(l.quantity, price);
    const b = toCents(l.estimatedAmount);
    const w = by.get(col.id) ?? { lineIds: [], total: 0, budget: 0 };
    w.lineIds.push(l.id);
    w.total += amount;
    w.budget += b;
    by.set(col.id, w);
    total += amount;
    budget += b;
  }
  const pctOf = (save: number, base: number) => (base ? Math.round((save / base) * 10_000) / 100 : null);
  const winners = columns
    .filter((c) => by.has(c.id))
    .map((c) => {
      const w = by.get(c.id)!;
      return { id: c.id, lineIds: w.lineIds, total: w.total / 100, budget: w.budget / 100, savings: (w.budget - w.total) / 100, savingsPct: pctOf(w.budget - w.total, w.budget) };
    });
  return { winners, total: total / 100, budget: budget / 100, savings: (budget - total) / 100, savingsPct: pctOf(budget - total, budget), notAwarded };
}

/** Each line to the column with the lowest price above zero (the first on a tie); a line nobody priced is left out. */
export function lowestPerLine(lines: SheetLine[], columns: SheetColumn[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const l of lines) {
    let best: { id: string; cents: number } | null = null;
    for (const c of columns) {
      const price = c.prices[l.id];
      if (price === undefined || price === null || !Number.isFinite(price) || price <= 0) continue;
      const v = toCents(price);
      if (!best || v < best.cents) best = { id: c.id, cents: v };
    }
    if (best) out[l.id] = best.id;
  }
  return out;
}
