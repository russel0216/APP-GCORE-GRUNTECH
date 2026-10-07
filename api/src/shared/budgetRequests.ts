import { prisma } from '../prisma';

/**
 * Budget requests used to CHANGE a project's budget: approval wrote a
 * BUDGETED row into the ledger and that was the end of them. Since
 * 2026-10-07 a budget request is project CASH — approved, released, spent
 * and liquidated — and an APPROVED one is cash finance still owes.
 *
 * A request approved under the old rule has its BUDGETED row and nothing to
 * release, and left APPROVED it would sit in finance's "to release" queue and
 * count against the working position for ever. So the seed closes each one:
 * released, spent and liquidated at its own amount on the day it was
 * approved, with a note saying what it was. The ledger row it wrote is kept —
 * it is the history of that budget — and nothing is deleted.
 *
 * Idempotent: a request already closed, or one raised under the new rule (no
 * BUDGETED row of its own), is left alone.
 */
export async function closeLegacyBudgetIncreases(): Promise<number> {
  const approved = await prisma.budgetRequest.findMany({
    where: { status: 'APPROVED', amountReleased: 0, liquidatedAt: null },
    select: { id: true, number: true, amount: true, approvedAt: true, createdAt: true, notes: true },
  });
  let closed = 0;
  for (const br of approved) {
    const increase = await prisma.jobCostEntry.findFirst({
      where: { sourceType: 'budget_request', sourceId: br.id, state: 'BUDGETED' },
      select: { id: true },
    });
    if (!increase) continue;
    const at = br.approvedAt ?? br.createdAt;
    const note = `Budget increase under the rule before 2026-10-07: approval raised the project's budget by ${Number(br.amount).toFixed(2)}; no cash was released. Closed by the seed.`;
    await prisma.budgetRequest.update({
      where: { id: br.id },
      data: {
        status: 'LIQUIDATED',
        amountReleased: br.amount,
        amountSpent: br.amount,
        releasedAt: at,
        liquidatedAt: at,
        notes: br.notes ? `${br.notes}\n${note}` : note,
      },
    });
    closed++;
  }
  return closed;
}
