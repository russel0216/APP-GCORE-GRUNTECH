import { Prisma } from '@prisma/client';
import { prisma } from '../prisma';
import type { ResolvedUser } from '../permissions/resolve';
import { can } from '../permissions/resolve';
import { addMonths, daysBetween } from './aftermarket';
import { manilaDate } from './day';
import { hrSettings, settingList, type HrSettings } from './hr';

/**
 * Probationary and trainee evaluations (model §4.7).
 *
 * The rules a route and a dashboard both need, kept out of the route so the
 * dashboard's "who is due" and the list's "who is due" can never disagree —
 * they are the same function.
 *
 * Three things this module holds to:
 *
 *   · **Due is derived, never stored.** A milestone falls out of `dateHired`
 *     (or the date a trainee was absorbed), the configured months and the
 *     period end. A row that said "due" would be wrong the moment HR extended
 *     a period or corrected a hire date.
 *   · **Regularisation is an approved document, not a field edit.** The
 *     employee row changes only inside the settled-approval subscriber in
 *     routes/evaluations.ts, and only when the approval chain did not include
 *     the person being evaluated.
 *   · **The subject reads only what has been approved.** A draft or a pending
 *     evaluation is the evaluator's working paper; showing it to the person
 *     it is about turns a form into a negotiation.
 */

export type EvaluationKindKey = 'PROBATIONARY' | 'TRAINEE';
export type Recommendation = 'REGULARIZE' | 'EXTEND' | 'END' | 'ABSORB';

/** The statuses under which an evaluation still counts for its milestone. */
export const LIVE_STATUSES = ['SCHEDULED', 'DRAFT', 'PENDING_APPROVAL', 'APPROVED'] as const;

// ── Milestones ───────────────────────────────────────────────────────────────

/**
 * The fixed milestone names. Month milestones are `MONTH_<n>` and take their
 * `n` from `hr.rules.evaluationMilestoneMonths`, so the label is computed;
 * these two are the ones that are not.
 */
export const MILESTONE_LABEL: Record<string, string> = {
  END: 'End of period',
  ADHOC: 'Ad hoc',
};

export function milestoneLabel(milestone: string): string {
  if (milestone in MILESTONE_LABEL) return MILESTONE_LABEL[milestone];
  const m = /^MONTH_(\d+)$/.exec(milestone);
  if (m) return `Month ${m[1]}`;
  return milestone;
}

export interface PeriodSubject {
  employmentType: string;
  dateHired: Date | null;
  periodEndDate: Date | null;
}

/** The evaluation kind an employee's employment type calls for, or null. */
export function kindFor(employmentType: string): EvaluationKindKey | null {
  if (employmentType === 'PROBATIONARY') return 'PROBATIONARY';
  if (employmentType === 'TRAINEE') return 'TRAINEE';
  return null;
}

/**
 * When the current period ends.
 *
 * A typed `periodEndDate` always wins — it is where an EXTEND lands and where
 * HR records a negotiated period. Without one, probation runs
 * `probationMonths` from the anchor. A trainee has no statutory period, so
 * with no date typed there is no end — the milestone list then has no END and
 * the employee record says so.
 */
export function probationEnd(
  employee: PeriodSubject,
  settings: Pick<HrSettings, 'probationMonths'>,
  anchor: Date | null = employee.dateHired,
): Date | null {
  if (employee.periodEndDate) return employee.periodEndDate;
  if (employee.employmentType === 'PROBATIONARY' && anchor) {
    return addMonths(anchor, settings.probationMonths);
  }
  return null;
}

export interface Milestone {
  milestone: string;
  dueDate: Date;
}

/**
 * The evaluations a period calls for, in date order.
 *
 * Month milestones count from the anchor (the hire date, or the day a trainee
 * was absorbed into probation — see `periodAnchor`), and only those that fall
 * before the period end are kept: a "month 5" that lands after a four-month
 * probation is not a milestone, it is a mistake. END is the period end itself.
 */
export function evaluationMilestones(
  employee: PeriodSubject,
  settings: Pick<HrSettings, 'probationMonths' | 'evaluationMilestoneMonths'>,
  anchor: Date | null = employee.dateHired,
): Milestone[] {
  const end = probationEnd(employee, settings, anchor);
  const out: Milestone[] = [];
  if (anchor) {
    for (const months of settings.evaluationMilestoneMonths) {
      const dueDate = addMonths(anchor, months);
      if (end && dueDate.getTime() >= end.getTime()) continue;
      out.push({ milestone: `MONTH_${months}`, dueDate });
    }
  }
  if (end) out.push({ milestone: 'END', dueDate: end });
  return out;
}

/**
 * Where a period is counted from.
 *
 * Normally the hire date. A trainee who was ABSORBED into probation keeps
 * their hire date (it is when they joined) but starts a fresh period on the
 * day the absorption took effect — so the anchor is that evaluation's
 * effective date, read off the approved document rather than stored twice.
 */
export async function periodAnchor(
  employee: PeriodSubject & { id: string },
  tx: Prisma.TransactionClient | typeof prisma = prisma,
): Promise<Date | null> {
  if (employee.employmentType !== 'PROBATIONARY') return employee.dateHired;
  const absorbed = await tx.employeeEvaluation.findFirst({
    where: { employeeId: employee.id, status: 'APPROVED', recommendation: 'ABSORB' },
    orderBy: { approvedAt: 'desc' },
    select: { effectiveDate: true, approvedAt: true },
  });
  if (!absorbed) return employee.dateHired;
  return absorbed.effectiveDate ?? absorbed.approvedAt ?? employee.dateHired;
}

// ── Recommendations and scoring ──────────────────────────────────────────────

/** REGULARIZE / EXTEND / END for probation; ABSORB / END for a trainee. */
export function allowedRecommendations(kind: string): Recommendation[] {
  return kind === 'TRAINEE' ? ['ABSORB', 'END'] : ['REGULARIZE', 'EXTEND', 'END'];
}

export const RECOMMENDATION_LABEL: Record<Recommendation, string> = {
  REGULARIZE: 'Regularise',
  EXTEND: 'Extend the period',
  END: 'End the engagement',
  ABSORB: 'Absorb into probation',
};

/**
 * The weighted mean of the rated lines, to two decimals — or null when nothing
 * has been rated yet. Unrated lines are left out rather than counted as zero:
 * a half-filled form has a partial score, not a failing one.
 */
export function evaluationScore(
  lines: { weight: Prisma.Decimal | number; rating: number | null }[],
): number | null {
  let weighted = 0;
  let weights = 0;
  for (const line of lines) {
    if (line.rating == null) continue;
    const w = Number(line.weight);
    weighted += w * line.rating;
    weights += w;
  }
  if (weights === 0) return null;
  return Math.round((weighted / weights) * 100) / 100;
}

// ── Criteria ─────────────────────────────────────────────────────────────────

export interface Criterion {
  key: string;
  name: string;
  description?: string | null;
  appliesTo: 'PROBATIONARY' | 'TRAINEE' | 'BOTH';
  weight: number;
  sortOrder: number;
  isActive: boolean;
}

export const CRITERIA_KEY = 'hr.evaluationCriteria';

export async function evaluationCriteria(): Promise<Criterion[]> {
  return settingList<Criterion>(CRITERIA_KEY, []);
}

/**
 * The lines a new evaluation of this kind starts with — a SNAPSHOT of the
 * criteria as they stand now, so a renamed or retired criterion never rewrites
 * a form somebody has already signed.
 */
export function snapshotLines(criteria: Criterion[], kind: string) {
  return criteria
    .filter((c) => c.isActive && (c.appliesTo === 'BOTH' || c.appliesTo === kind))
    .sort((a, b) => a.sortOrder - b.sortOrder || a.key.localeCompare(b.key))
    .map((c, i) => ({
      criterionKey: c.key,
      sortOrder: i + 1,
      name: c.name,
      weight: new Prisma.Decimal(c.weight),
    }));
}

// ── Visibility ───────────────────────────────────────────────────────────────

export interface VisibilitySubject {
  status: string;
  evaluatorId: string;
  scheduledById?: string | null;
  employee: { userId: string | null };
}

/**
 * Who may read an evaluation.
 *
 *   view_all            everything
 *   the evaluator       their own, at every stage (view_own)
 *   whoever scheduled   the one they scheduled (view_own)
 *   the person rated    only once APPROVED (view_own) — never the draft
 *
 * Anyone else gets a 404, not a 403: "there is an evaluation about you" is
 * itself information the subject is not owed while it is pending.
 */
export function visibleTo(user: ResolvedUser, ev: VisibilitySubject): boolean {
  if (can(user, 'ghr.evaluations.view_all')) return true;
  if (!can(user, 'ghr.evaluations.view_own')) return false;
  if (ev.evaluatorId === user.id) return true;
  if (ev.scheduledById && ev.scheduledById === user.id) return true;
  if (ev.employee.userId === user.id) return ev.status === 'APPROVED';
  return false;
}

// ── Due, derived on read ─────────────────────────────────────────────────────

export interface DueRow {
  employee: {
    id: string;
    employeeNo: string;
    firstName: string;
    lastName: string;
    position: string | null;
    department: { id: string; name: string } | null;
    employmentType: string;
    dateHired: Date | null;
  };
  kind: EvaluationKindKey;
  milestone: string;
  dueDate: Date;
  /** Negative when overdue. */
  daysLeft: number;
  overdue: boolean;
  periodEnd: Date | null;
  /** An open evaluation already covers it — listed so the panel can link to it. */
  evaluation: { id: string; number: string; status: string } | null;
}

/**
 * Every milestone that is due within the notice window (or already past)
 * across probationary and trainee staff, with the evaluation that covers it
 * when one exists.
 *
 * "Covers" means: same employee, same milestone, same kind, still live, and
 * raised for this due date or a later one. That last clause is what makes an
 * extension work — the END evaluation that recommended EXTEND carries the old
 * period end as its due date, so once the period has moved the new END is due
 * again rather than being read as already done.
 */
export async function dueEvaluations(
  opts: { employeeId?: string; asOf?: Date; includeCovered?: boolean } = {},
): Promise<DueRow[]> {
  const settings = await hrSettings();
  // Days are counted from the MANILA date, the same kind of value as every due
  // date here. Counted from the UTC date, until 08:00 each morning a milestone
  // five days off read "in 6 days" and one a day late read "due today". The
  // notice window counts the same whole days, so its edge does not move with
  // the hour either.
  const today = manilaDate(opts.asOf ?? new Date());

  const employees = await prisma.employee.findMany({
    where: {
      isActive: true,
      employmentType: { in: ['PROBATIONARY', 'TRAINEE'] },
      ...(opts.employeeId ? { id: opts.employeeId } : {}),
    },
    select: {
      id: true,
      employeeNo: true,
      firstName: true,
      lastName: true,
      position: true,
      employmentType: true,
      dateHired: true,
      periodEndDate: true,
      department: { select: { id: true, name: true } },
    },
    orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }],
  });
  if (!employees.length) return [];

  const existing = await prisma.employeeEvaluation.findMany({
    where: {
      employeeId: { in: employees.map((e) => e.id) },
      status: { in: [...LIVE_STATUSES] },
    },
    select: { id: true, number: true, status: true, employeeId: true, milestone: true, kind: true, dueDate: true },
    orderBy: { createdAt: 'desc' },
  });

  const rows: DueRow[] = [];
  for (const employee of employees) {
    const kind = kindFor(employee.employmentType);
    if (!kind) continue;
    const anchor = await periodAnchor(employee);
    const periodEnd = probationEnd(employee, settings, anchor);
    for (const m of evaluationMilestones(employee, settings, anchor)) {
      const covering = existing.find(
        (e) =>
          e.employeeId === employee.id &&
          e.milestone === m.milestone &&
          e.kind === kind &&
          (e.dueDate == null || e.dueDate.getTime() >= m.dueDate.getTime()),
      );
      if (covering && covering.status === 'APPROVED') continue;
      if (covering && !opts.includeCovered) continue;
      const daysLeft = daysBetween(today, m.dueDate);
      if (daysLeft > settings.evaluationNoticeDays) continue;
      rows.push({
        employee: {
          id: employee.id,
          employeeNo: employee.employeeNo,
          firstName: employee.firstName,
          lastName: employee.lastName,
          position: employee.position,
          department: employee.department,
          employmentType: employee.employmentType,
          dateHired: employee.dateHired,
        },
        kind,
        milestone: m.milestone,
        dueDate: m.dueDate,
        daysLeft,
        overdue: daysLeft < 0,
        periodEnd,
        evaluation: covering ? { id: covering.id, number: covering.number, status: covering.status } : null,
      });
    }
  }
  rows.sort((a, b) => a.dueDate.getTime() - b.dueDate.getTime());
  return rows;
}

/**
 * The full milestone picture for one employee — every milestone, covered or
 * not, past or future. The employee record's Evaluations tab reads this.
 * Days left count from the Manila date of `asOf`, as in `dueEvaluations`.
 */
export async function milestonesFor(employeeId: string, asOf: Date = new Date()) {
  const settings = await hrSettings();
  const employee = await prisma.employee.findUnique({
    where: { id: employeeId },
    select: { id: true, employmentType: true, dateHired: true, periodEndDate: true, dateRegularized: true },
  });
  if (!employee) return null;
  const kind = kindFor(employee.employmentType);
  const anchor = await periodAnchor(employee);
  const periodEnd = kind ? probationEnd(employee, settings, anchor) : null;
  const milestones = kind ? evaluationMilestones(employee, settings, anchor) : [];
  const existing = await prisma.employeeEvaluation.findMany({
    where: { employeeId, status: { in: [...LIVE_STATUSES] } },
    select: { id: true, number: true, status: true, milestone: true, kind: true, dueDate: true, recommendation: true },
    orderBy: { createdAt: 'desc' },
  });
  return {
    kind,
    anchor,
    periodEnd,
    milestones: milestones.map((m) => {
      const covering = existing.find(
        (e) =>
          e.milestone === m.milestone &&
          e.kind === kind &&
          (e.dueDate == null || e.dueDate.getTime() >= m.dueDate.getTime()),
      );
      return {
        milestone: m.milestone,
        label: milestoneLabel(m.milestone),
        dueDate: m.dueDate,
        daysLeft: daysBetween(manilaDate(asOf), m.dueDate),
        evaluation: covering
          ? { id: covering.id, number: covering.number, status: covering.status, recommendation: covering.recommendation }
          : null,
      };
    }),
  };
}
