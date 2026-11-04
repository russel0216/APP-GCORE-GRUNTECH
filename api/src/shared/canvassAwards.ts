import { prisma } from '../prisma';

/**
 * Canvasses awarded before the award went line by line (2026-11-04) carry
 * only their winner's `isSelected`. This marks that winner's quotes on the
 * sheet's lines `awarded`, so every reader takes the award one way. Run by
 * the seed on every deploy: idempotent — a canvass with any awarded quote is
 * left as it is.
 */
export async function backfillLineAwards(): Promise<number> {
  const rows = await prisma.canvass.findMany({
    where: { status: 'AWARDED', suppliers: { some: { isSelected: true } }, NOT: { suppliers: { some: { quotes: { some: { awarded: true } } } } } },
    select: { id: true, lineIds: true, suppliers: { where: { isSelected: true }, select: { id: true } } },
  });
  for (const c of rows) {
    await prisma.canvassQuote.updateMany({
      where: { canvassSupplierId: { in: c.suppliers.map((s) => s.id) }, ...(c.lineIds.length ? { requestItemId: { in: c.lineIds } } : {}) },
      data: { awarded: true },
    });
  }
  return rows.length;
}
