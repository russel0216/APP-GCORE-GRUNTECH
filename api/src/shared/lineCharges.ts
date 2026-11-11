import { Prisma } from '@prisma/client';
import { prisma } from '../prisma';
import { badRequest } from '../http/kit';
import { officeLineFor } from './officeBudget';

/**
 * WHERE EACH LINE IS CHARGED (2026-11-11, the owner's call: "allow a multiple
 * allocation for different project — a Statement of Account for a credit
 * card used on different projects or the office; if created for a specific
 * project make it the default per item").
 *
 * A reimbursement's receipts and a budget request's items may each name their
 * own project and budget line, or an office budget line. The ONE rule for
 * storing it, `collapse()`:
 *
 * - every line charged to the same place (or the form sent none per line):
 *   the document is charged WHOLE — the header carries the place, the lines
 *   none, `split` false. Every reader written before this keeps working.
 * - lines charged to different places: `split` true, the header names no
 *   project and no office line, and each line carries its own.
 *
 * A split document's money is read line by line wherever it lands: the
 * project ledger (`chargeGroups()` when it posts), Budget Monitoring's
 * Requested column, the office budget's figures, the approval's
 * "Project budget agreed" step (`jobIdsOf()`: every project charged).
 */

export interface LineCharge {
  jobId: string | null;
  costCategoryId: string | null;
  officeBudgetLineId: string | null;
}

export const NO_CHARGE: LineCharge = { jobId: null, costCategoryId: null, officeBudgetLineId: null };

/** One key per place: an office line, a project's budget line, or nowhere (overheads). */
export function chargeKey(c: LineCharge): string {
  if (c.officeBudgetLineId) return `o:${c.officeBudgetLineId}`;
  if (c.jobId) return `p:${c.jobId}:${c.costCategoryId ?? ''}`;
  return 'none';
}

/** A line's own place, else the document's default. */
function effective(line: Partial<LineCharge>, header: LineCharge): LineCharge {
  if (line.officeBudgetLineId) return { jobId: null, costCategoryId: null, officeBudgetLineId: line.officeBudgetLineId };
  if (line.jobId) return { jobId: line.jobId, costCategoryId: line.costCategoryId || null, officeBudgetLineId: null };
  return header;
}

/**
 * The document's header and each line's stored place: charged whole when
 * every line lands in one place, else split.
 */
export function collapse(lines: Partial<LineCharge>[], header: LineCharge): { split: boolean; header: LineCharge; lines: LineCharge[] } {
  const each = lines.map((l) => effective(l, header));
  const keys = new Set(each.map(chargeKey));
  if (keys.size <= 1) return { split: false, header: each[0] ?? header, lines: each.map(() => NO_CHARGE) };
  return { split: true, header: NO_CHARGE, lines: each };
}

/**
 * Every place is real: a project on file and not cancelled, with a budget
 * line; an office line open (or the one a line already carries — `keep`).
 * `requireCharge`: a split document's line must name somewhere.
 */
export async function checkLineCharges(lines: LineCharge[], opts: { keepOffice?: (string | null)[]; requireCharge?: boolean } = {}) {
  const jobIds = [...new Set(lines.map((l) => l.jobId).filter((id): id is string => !!id))];
  const categoryIds = [...new Set(lines.map((l) => l.costCategoryId).filter((id): id is string => !!id))];
  const [jobs, categories] = await Promise.all([
    jobIds.length ? prisma.job.findMany({ where: { id: { in: jobIds } }, select: { id: true, number: true, status: true } }) : [],
    categoryIds.length ? prisma.costCategory.findMany({ where: { id: { in: categoryIds } }, select: { id: true } }) : [],
  ]);
  for (const [i, l] of lines.entries()) {
    const n = i + 1;
    if (l.jobId && l.officeBudgetLineId) throw badRequest(`Line ${n}: charge it to a project or to an office budget line, not both`);
    if (l.jobId) {
      const job = jobs.find((j) => j.id === l.jobId);
      if (!job || job.status === 'CANCELLED') throw badRequest(`Line ${n}: that project cannot be charged`);
      if (!l.costCategoryId) throw badRequest(`Line ${n}: which budget line of ${job.number}?`);
      if (!categories.some((c) => c.id === l.costCategoryId)) throw badRequest(`Line ${n}: that budget line is not on file`);
    } else if (l.officeBudgetLineId) {
      await officeLineFor(l.officeBudgetLineId, (opts.keepOffice ?? []).includes(l.officeBudgetLineId) ? l.officeBudgetLineId : null);
    } else if (opts.requireCharge) {
      throw badRequest(`Line ${n}: say which project or office budget line it is charged to`);
    }
  }
}

/** The places a document's money lands and how much in each, in the order first met. */
export function chargeGroups(lines: { charge: LineCharge; amount: number }[]): { charge: LineCharge; amount: number }[] {
  const out = new Map<string, { charge: LineCharge; amount: number }>();
  for (const l of lines) {
    const k = chargeKey(l.charge);
    const g = out.get(k);
    if (g) g.amount = Math.round((g.amount + l.amount) * 100) / 100;
    else out.set(k, { charge: l.charge, amount: Math.round(l.amount * 100) / 100 });
  }
  return [...out.values()];
}

/** A document's lines as charges: the line's own on a split document, the header's otherwise. */
export function linesAsCharges<L extends Partial<LineCharge> & { amount: Prisma.Decimal | number }>(
  doc: LineCharge & { split: boolean },
  lines: L[],
): { charge: LineCharge; amount: number }[] {
  return lines.map((l) => ({
    charge: doc.split ? { jobId: l.jobId ?? null, costCategoryId: l.costCategoryId ?? null, officeBudgetLineId: l.officeBudgetLineId ?? null } : doc,
    amount: Number(l.amount),
  }));
}

/** Every project a document charges — the "Project budget agreed" step's projects. */
export function jobIdsOf(doc: LineCharge & { split: boolean }, lines: Partial<LineCharge>[]): string[] {
  if (!doc.split) return doc.jobId ? [doc.jobId] : [];
  return [...new Set(lines.map((l) => l.jobId).filter((id): id is string => !!id))];
}

/** What a list says it is charged to: "Several (3)" for a split document. */
export const SEVERAL = (n: number) => `Several (${n})`;
