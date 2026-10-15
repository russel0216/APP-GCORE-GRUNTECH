/**
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
