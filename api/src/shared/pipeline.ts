import { Prisma } from '@prisma/client';

/**
 * Pipeline rules shared by the sales board and Insights.
 *
 * One value rule. Insights briefly counted only approved revisions and showed
 * an open quotation as worth nothing while Sales Analytics showed its real
 * value — two screens disagreeing is the bug this file exists to prevent.
 */

/**
 * A quotation's value: its APPROVED revision's total, else the total of its
 * highest-numbered revision, else 0.
 *
 * Only one revision may be APPROVED (Phase 3), so "the approved one" is
 * unambiguous. The revisions may arrive in any order — the caller's
 * `orderBy` is not relied on.
 */
export function quotationValue(
  revisions: { status: string; total: Prisma.Decimal | number; revision: number }[],
): number {
  const approved = revisions.find((r) => r.status === 'APPROVED');
  const latest = revisions.reduce<(typeof revisions)[number] | null>(
    (best, r) => (best === null || r.revision > best.revision ? r : best),
    null,
  );
  const chosen = approved ?? latest;
  return chosen ? Number(chosen.total) : 0;
}
