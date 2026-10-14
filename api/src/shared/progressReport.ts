import { Prisma } from '@prisma/client';
import { prisma } from '../prisma';

/**
 * The Accomplishment Report (2026-10-15, the owner's sample — "The Village
 * at Lipa"): a progress report numbered under its project, weighed against
 * the schedule of values, written day by day with pictures, and approved on
 * the engine's route (Technical Manager › Team Leader).
 */

/**
 * The overall status a report names — the standard words a site report
 * uses, so a list of reports reads alike; a note after it says the rest
 * ("Behind schedule – Awaiting materials"). A value outside the list (a
 * report written before it) prints as written.
 */
export const PROGRESS_OVERALL = [
  { key: 'ON_SCHEDULE', label: 'On schedule' },
  { key: 'AHEAD', label: 'Ahead of schedule' },
  { key: 'BEHIND', label: 'Behind schedule' },
  { key: 'CORRECTIVE', label: 'Ongoing – For corrective works' },
  { key: 'ON_HOLD', label: 'On hold' },
  { key: 'COMPLETED', label: 'Completed' },
] as const;

export function overallStatusLabel(key: string | null | undefined, note?: string | null): string | null {
  if (!key && !note) return null;
  const label = PROGRESS_OVERALL.find((o) => o.key === key)?.label ?? key ?? '';
  return [label, note?.trim()].filter(Boolean).join(' – ');
}

/**
 * A report's number is its project's with its place in the chain —
 * `GT-PRJ-2026-0112-PR-03` — so two projects' reports can never collide and
 * the number says whose it is (the owner's call). A billing is `…-PB-01`.
 * Derived inside the creating transaction from the per-project sequence,
 * the sales order's `<base>.1` rule; `reportNo` / `billingNo` are unique per
 * project, so the number is too.
 */
export const reportNumber = (jobNumber: string, reportNo: number) => `${jobNumber}-PR-${String(reportNo).padStart(2, '0')}`;
export const billingNumber = (jobNumber: string, billingNo: number) => `${jobNumber}-PB-${String(billingNo).padStart(2, '0')}`;

/**
 * Each scope line's weight — its value over the schedule's total — and what
 * it adds to the project's percentage at a given to-date figure. The
 * project's percentage is the sum of the weighted figures, so the headline
 * is arithmetic over the lines, never typed.
 */
export function weighOf(value: number, total: number): number {
  return total > 0 ? value / total : 0;
}

/**
 * A phase's percentage from its tasks: each task's weight (1 when none is
 * typed) times its own progress — a DONE task counts 100 — over the
 * weights' sum. Null when the phase has no tasks to go by.
 */
export function phasePctFromTasks(tasks: { status: string; progressPct: number; weight: Prisma.Decimal | number | null }[]): number | null {
  if (!tasks.length) return null;
  let total = 0;
  let done = 0;
  for (const t of tasks) {
    const w = t.weight == null ? 1 : Number(t.weight);
    if (!(w > 0)) continue;
    total += w;
    done += (w * (t.status === 'DONE' ? 100 : Math.max(0, Math.min(100, t.progressPct)))) / 100;
  }
  return total > 0 ? Math.round((done / total) * 10000) / 100 : null;
}

/**
 * Reports and billings numbered before 2026-10-15 take the project-scoped
 * number, once (`seed.progressRenumbered`); the old number stays on the
 * record as `legacyNumber`, and one audit row says how many moved. A
 * SUBMITTED report (a status nothing set) goes back to DRAFT so it can be
 * submitted on the route.
 */
export async function renumberProgressDocs(): Promise<number> {
  const MARK = 'seed.progressRenumbered';
  if (await prisma.setting.findUnique({ where: { key: MARK } })) return 0;
  let moved = 0;
  const reports = await prisma.progressReport.findMany({ select: { id: true, number: true, reportNo: true, job: { select: { number: true } } } });
  for (const r of reports) {
    const next = reportNumber(r.job.number, r.reportNo);
    if (next === r.number) continue;
    await prisma.progressReport.update({ where: { id: r.id }, data: { number: next, legacyNumber: r.number } });
    moved++;
  }
  const billings = await prisma.progressBilling.findMany({ select: { id: true, number: true, billingNo: true, job: { select: { number: true } } } });
  for (const b of billings) {
    const next = billingNumber(b.job.number, b.billingNo);
    if (next === b.number) continue;
    await prisma.progressBilling.update({ where: { id: b.id }, data: { number: next, legacyNumber: b.number } });
    moved++;
  }
  await prisma.progressReport.updateMany({ where: { status: 'SUBMITTED' }, data: { status: 'DRAFT' } });
  await prisma.setting.create({ data: { key: MARK, value: { at: new Date().toISOString(), moved } as Prisma.InputJsonValue } });
  if (moved) {
    await prisma.auditLog.create({
      data: {
        entityType: 'progress_report',
        entityId: 'list',
        action: 'UPDATED',
        summary: `Numbered ${moved} progress report(s) and billing(s) under their project (the old number kept on each)`,
      },
    });
  }
  return moved;
}
