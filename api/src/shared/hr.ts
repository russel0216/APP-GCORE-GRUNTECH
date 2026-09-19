import { prisma } from '../prisma';
import { badRequest } from '../http/kit';

/**
 * HR rules that more than one route needs: face matching, the working day,
 * how overtime hours are counted, and how leave days are counted.
 *
 * Everything configurable lives in Settings rather than in constants — the
 * working day, the dinner break, the overtime premium and the late grace
 * period all differ by company and none of them deserve a deploy to change.
 */

// ── Settings ─────────────────────────────────────────────────────────────────

export interface HrSettings {
  /** "HH:mm" — start of the normal working day, for lateness. */
  workStart: string;
  workEnd: string;
  /** Minutes after workStart before someone counts as late. */
  graceMinutes: number;
  /** Unpaid break inside the normal day, in minutes. */
  breakMinutes: number;
  /** The pre-checked dinner break on overtime. */
  dinnerBreakStart: string;
  dinnerBreakEnd: string;
  dinnerBreakMinutes: number;
  /**
   * Overtime premium. Philippine law sets at least 125% of the hourly rate for
   * ordinary-day overtime, so a project should bear that, not the plain rate.
   */
  overtimeMultiplier: number;
  /** Hours in a normal day, used to derive an hourly rate from a daily one. */
  hoursPerDay: number;
  /** Face match threshold — lower is stricter. 0.6 is the face-api default. */
  faceThreshold: number;
}

const DEFAULTS: HrSettings = {
  workStart: '08:00',
  workEnd: '17:00',
  graceMinutes: 15,
  breakMinutes: 60,
  dinnerBreakStart: '17:00',
  dinnerBreakEnd: '18:00',
  dinnerBreakMinutes: 60,
  overtimeMultiplier: 1.25,
  hoursPerDay: 8,
  faceThreshold: 0.6,
};

export async function hrSettings(): Promise<HrSettings> {
  const row = await prisma.setting.findUnique({ where: { key: 'hr.rules' } });
  if (!row) return DEFAULTS;
  return { ...DEFAULTS, ...(row.value as Partial<HrSettings>) };
}

export async function saveHrSettings(value: Partial<HrSettings>): Promise<HrSettings> {
  const merged = { ...(await hrSettings()), ...value };
  await prisma.setting.upsert({
    where: { key: 'hr.rules' },
    create: {
      key: 'hr.rules',
      value: merged,
      description: 'Working day, breaks, overtime premium and face-match threshold',
    },
    update: { value: merged },
  });
  return merged;
}

// ── Time helpers ─────────────────────────────────────────────────────────────

/** "HH:mm" → minutes since midnight. */
export function toMinutes(hhmm: string): number {
  const match = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
  if (!match) throw badRequest(`"${hhmm}" is not a time — use HH:mm, e.g. 17:30`);
  const h = Number(match[1]);
  const m = Number(match[2]);
  if (h > 23 || m > 59) throw badRequest(`"${hhmm}" is not a valid time`);
  return h * 60 + m;
}

export function fromMinutes(minutes: number): string {
  const m = ((minutes % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

/** The local date, as a UTC-midnight Date, so a day key is stable. */
export function dayKey(at: Date): Date {
  return new Date(Date.UTC(at.getFullYear(), at.getMonth(), at.getDate()));
}

// ── Face matching ────────────────────────────────────────────────────────────

/**
 * Euclidean distance between two 128-float face descriptors.
 *
 * face-api.js treats < 0.6 as the same person. Lower is a closer match.
 */
export function faceDistance(a: number[], b: number[]): number {
  if (a.length !== b.length) return Number.POSITIVE_INFINITY;
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    const d = a[i] - b[i];
    sum += d * d;
  }
  return Math.sqrt(sum);
}

export interface FaceMatch {
  employeeId: string;
  distance: number;
  name: string;
}

/**
 * Finds the closest enrolled face.
 *
 * Returns the best match AND the runner-up: when two people are nearly as
 * close, the match is ambiguous and should not be trusted even if the best
 * distance is under the threshold.
 */
export async function matchFace(
  descriptor: number[],
): Promise<{ best: FaceMatch | null; runnerUp: FaceMatch | null; threshold: number }> {
  if (descriptor.length !== 128) {
    throw badRequest('That does not look like a face descriptor — expected 128 values');
  }

  const settings = await hrSettings();
  const enrollments = await prisma.faceEnrollment.findMany({
    include: { employee: { select: { id: true, firstName: true, lastName: true, isActive: true } } },
  });

  // Best distance per employee, across all their enrolled samples.
  const byEmployee = new Map<string, FaceMatch>();
  for (const row of enrollments) {
    if (!row.employee.isActive) continue;
    const stored = row.descriptor as unknown as number[];
    if (!Array.isArray(stored) || stored.length !== 128) continue;

    const distance = faceDistance(descriptor, stored);
    const current = byEmployee.get(row.employeeId);
    if (!current || distance < current.distance) {
      byEmployee.set(row.employeeId, {
        employeeId: row.employeeId,
        distance,
        name: `${row.employee.firstName} ${row.employee.lastName}`,
      });
    }
  }

  const ranked = [...byEmployee.values()].sort((a, b) => a.distance - b.distance);
  return {
    best: ranked[0] ?? null,
    runnerUp: ranked[1] ?? null,
    threshold: settings.faceThreshold,
  };
}

// ── The working day ──────────────────────────────────────────────────────────

export interface DayResult {
  status: 'PRESENT' | 'LATE';
  lateMinutes: number;
}

export function classifyArrival(timeIn: Date, settings: HrSettings): DayResult {
  const arrived = timeIn.getHours() * 60 + timeIn.getMinutes();
  const expected = toMinutes(settings.workStart);
  const late = arrived - expected - settings.graceMinutes;
  return late > 0
    ? { status: 'LATE', lateMinutes: Math.round(late) }
    : { status: 'PRESENT', lateMinutes: 0 };
}

/** Minutes actually worked, net of the unpaid break. */
export function workedMinutes(timeIn: Date, timeOut: Date, settings: HrSettings): number {
  const gross = Math.round((timeOut.getTime() - timeIn.getTime()) / 60000);
  if (gross <= 0) return 0;
  // The break is only deducted from a day long enough to have taken one.
  return gross > settings.breakMinutes + 60 ? gross - settings.breakMinutes : gross;
}

// ── Overtime hours ───────────────────────────────────────────────────────────

/**
 * Hours between two wall-clock times, less the dinner break when it applies.
 *
 * The break is only deducted if the overtime actually spans it — filing 19:00
 * to 22:00 should not lose an hour for a break that finished before it started.
 */
export function overtimeHours(
  start: string,
  end: string,
  dinnerBreak: boolean,
  settings: HrSettings,
): number {
  const from = toMinutes(start);
  let to = toMinutes(end);
  // Past midnight.
  if (to <= from) to += 1440;

  let minutes = to - from;

  if (dinnerBreak) {
    const breakFrom = toMinutes(settings.dinnerBreakStart);
    const breakTo = toMinutes(settings.dinnerBreakEnd);
    const overlap = Math.max(0, Math.min(to, breakTo) - Math.max(from, breakFrom));
    minutes -= Math.min(overlap, settings.dinnerBreakMinutes);
  }

  return Math.max(0, Math.round((minutes / 60) * 100) / 100);
}

/**
 * What an hour of this employee's overtime costs a project.
 *
 * Burdened, not the wage: dailyRate × burdenMultiplier ÷ hoursPerDay, then the
 * overtime premium. A project bears the real cost of the hour, which is more
 * than what lands in the payslip.
 */
export async function overtimeRate(
  employeeId: string,
): Promise<{ hourlyRate: number; multiplier: number; missingRate: boolean }> {
  const settings = await hrSettings();
  const employee = await prisma.employee.findUnique({
    where: { id: employeeId },
    select: { dailyRate: true, burdenMultiplier: true },
  });

  const daily = employee?.dailyRate ? Number(employee.dailyRate) : 0;
  const burden = employee?.burdenMultiplier ? Number(employee.burdenMultiplier) : 1;

  return {
    hourlyRate: Math.round(((daily * burden) / settings.hoursPerDay) * 10000) / 10000,
    multiplier: settings.overtimeMultiplier,
    missingRate: daily <= 0,
  };
}

// ── Leave days ───────────────────────────────────────────────────────────────

/**
 * Working days between two dates, counting half days from the times.
 *
 * Weekends are excluded. Public holidays are not modelled — Gruntech works
 * through some of them, and a wrong holiday calendar is worse than none.
 */
export function leaveDays(
  startDate: Date,
  endDate: Date,
  startTime: string | null,
  endTime: string | null,
  settings: HrSettings,
): number {
  if (endDate < startDate) throw badRequest('The end date is before the start date');

  const midday = toMinutes(settings.workStart) + (toMinutes(settings.workEnd) - toMinutes(settings.workStart)) / 2;

  let days = 0;
  const cursor = new Date(startDate);
  while (cursor <= endDate) {
    const weekday = cursor.getUTCDay();
    if (weekday !== 0 && weekday !== 6) days += 1;
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  if (days === 0) return 0;

  // A start time in the afternoon means the morning was worked, and vice versa.
  if (startTime && toMinutes(startTime) >= midday) days -= 0.5;
  if (endTime && toMinutes(endTime) <= midday) days -= 0.5;

  return Math.max(0.5, Math.round(days * 2) / 2);
}

/** Entitled + carried over − used, for one employee, type and year. */
export async function leaveBalance(employeeId: string, leaveTypeId: string, year: number) {
  const [balance, type] = await Promise.all([
    prisma.leaveBalance.findUnique({
      where: { employeeId_leaveTypeId_year: { employeeId, leaveTypeId, year } },
    }),
    prisma.leaveType.findUnique({ where: { id: leaveTypeId } }),
  ]);

  const entitled = balance ? Number(balance.entitled) : Number(type?.daysPerYear ?? 0);
  const carriedOver = balance ? Number(balance.carriedOver) : 0;
  const used = balance ? Number(balance.used) : 0;

  // Filed but not yet decided, shown separately so nobody over-commits.
  const pending = await prisma.leaveRequest.aggregate({
    where: { employeeId, leaveTypeId, status: 'PENDING_APPROVAL' },
    _sum: { days: true },
  });
  const pendingDays = pending._sum.days ? Number(pending._sum.days) : 0;

  return {
    entitled,
    carriedOver,
    used,
    pending: pendingDays,
    remaining: Math.round((entitled + carriedOver - used) * 100) / 100,
    remainingAfterPending: Math.round((entitled + carriedOver - used - pendingDays) * 100) / 100,
  };
}

/** Creates this year's balance row from the type's allotment if missing. */
export async function ensureBalance(employeeId: string, leaveTypeId: string, year: number) {
  const existing = await prisma.leaveBalance.findUnique({
    where: { employeeId_leaveTypeId_year: { employeeId, leaveTypeId, year } },
  });
  if (existing) return existing;

  const type = await prisma.leaveType.findUnique({ where: { id: leaveTypeId } });
  return prisma.leaveBalance.create({
    data: {
      employeeId,
      leaveTypeId,
      year,
      entitled: type?.daysPerYear ?? 0,
    },
  });
}
