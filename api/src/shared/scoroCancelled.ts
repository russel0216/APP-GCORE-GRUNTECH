import { prisma } from '../prisma';

/**
 * Once (2026-11-18, the owner's call): four quotations the SCORO import brought
 * across as LOST were Cancelled in SCORO ("SCORO status: Cancelled") — imported
 * before a lost quotation could say it was cancelled. They are marked Cancelled,
 * so the G-OPS dashboard's Lost card, the win rate and the lost reasons count
 * only real losses. Only a quotation still LOST, unmarked, with that very reason
 * is touched; one audit row each. Marked so it never runs again.
 */
const MARK = 'seed.scoroCancelledQuotations20261118';
const NUMBERS = ['0012501001', '0012501002', '0012608042', '0012609058'];

export async function markScoroCancelledQuotations(): Promise<string | null> {
  if (await prisma.setting.findUnique({ where: { key: MARK } })) return null;
  const rows = await prisma.quotation.findMany({
    where: { number: { in: NUMBERS }, outcome: 'LOST', OR: [{ lostKind: null }, { lostKind: 'LOST' }], lostReason: 'SCORO status: Cancelled' },
    select: { id: true, number: true, lostKind: true },
  });
  for (const q of rows) {
    await prisma.$transaction([
      prisma.quotation.update({ where: { id: q.id }, data: { lostKind: 'CANCELLED' } }),
      prisma.auditLog.create({
        data: {
          entityType: 'quotation',
          entityId: q.id,
          action: 'UPDATED',
          summary: `${q.number}: marked Cancelled — SCORO had it as Cancelled, the import as Lost`,
          before: { lostKind: q.lostKind },
          after: { lostKind: 'CANCELLED' },
        },
      }),
    ]);
  }
  await prisma.setting.create({ data: { key: MARK, value: { at: new Date().toISOString(), marked: rows.map((r) => r.number) } } });
  return rows.length ? `${rows.length} SCORO quotation${rows.length === 1 ? '' : 's'} marked Cancelled` : null;
}
