import { Prisma } from '@prisma/client';
import { prisma } from '../prisma';

/**
 * Costings priced under the markup rule are carried over to the margin rule
 * (2026-10-09, the owner's call: "remove markup and replace with margin",
 * "6th category contingency", "remove footer contingency and less discount").
 *
 * Before: contract = cost + cost × markup + cost × contingency − discount.
 * After:  contract = cost ÷ (1 − margin), the contingency a cost LINE of its
 *         own bucket, no discount.
 *
 * The contract value is a commercial fact and never moves. For each costing
 * still carrying a markup, a contingency % or a discount, this:
 *
 *   - writes the contingency as a line in the Contingency category, at the
 *     amount the percentage came to, and adds it to the stored cost;
 *   - derives the margin from the STORED contract value over that cost, to six
 *     decimals, so the summary reads the same margin the old figures implied
 *     (a discount larger than the markup leaves a negative one, which is the
 *     truth);
 *   - zeroes the three legacy columns, which is what makes a second run find
 *     nothing. Idempotent; the seed runs it on every deploy, and
 *     verify-costing runs it on a fixture of its own.
 *
 * The job behind a FINAL costing is untouched: its budget is the ledger's
 * BUDGETED rows, written when the project was built, not the costing's lines.
 */
export async function migrateCostingMargins(
  opts: { ids?: string[] } = {},
  tx: Prisma.TransactionClient = prisma,
): Promise<{ costings: number; contingencyLines: number }> {
  const contingency = await tx.costCategory.findUnique({ where: { code: 'CON' }, select: { id: true } });
  const legacy = await tx.costing.findMany({
    where: {
      ...(opts.ids ? { id: { in: opts.ids } } : {}),
      OR: [{ markupPct: { not: 0 } }, { contingencyPct: { not: 0 } }, { discountAmount: { not: 0 } }],
    },
    select: {
      id: true,
      totalCost: true,
      contractValue: true,
      contingencyPct: true,
      lines: { select: { sortOrder: true } },
    },
  });

  let contingencyLines = 0;
  for (const c of legacy) {
    const contract = Number(c.contractValue);
    const contingencyPct = Number(c.contingencyPct);
    let cost = Number(c.totalCost);

    if (contingencyPct > 0 && contingency) {
      const amount = Math.round(cost * contingencyPct * 100) / 100;
      if (amount > 0) {
        const pct = String(Number((contingencyPct * 100).toFixed(2)));
        await tx.costingLine.create({
          data: {
            costingId: c.id,
            costCategoryId: contingency.id,
            name: 'Contingency',
            description: `Contingency — ${pct}% of the project cost, as it was priced before the margin rule`,
            quantity: new Prisma.Decimal(1),
            unit: 'lot',
            unitCost: new Prisma.Decimal(amount),
            amount: new Prisma.Decimal(amount),
            sortOrder: c.lines.reduce((max, l) => Math.max(max, l.sortOrder), -1) + 1,
          },
        });
        cost = Math.round((cost + amount) * 100) / 100;
        contingencyLines++;
      }
    }

    const margin = contract > 0 ? Math.round(((contract - cost) / contract) * 1_000_000) / 1_000_000 : 0;
    await tx.costing.update({
      where: { id: c.id },
      data: {
        marginPct: new Prisma.Decimal(margin),
        totalCost: new Prisma.Decimal(cost),
        markupPct: new Prisma.Decimal(0),
        contingencyPct: new Prisma.Decimal(0),
        discountAmount: new Prisma.Decimal(0),
      },
    });
  }

  return { costings: legacy.length, contingencyLines };
}
