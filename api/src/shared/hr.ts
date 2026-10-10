import { Prisma } from '@prisma/client';
import { prisma } from '../prisma';
import { dayKey } from './day';
import { badRequest } from '../http/kit';
import { FACE_ENGINE } from './faceEngine';

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
  /**
   * Face match threshold — lower is stricter. 0.55 since the 2026-10-10 engine
   * (FACE_ENGINE): with three samples a person, it accepted 96% of genuine
   * captures in the benchmark and no wrong account, impostor or stranger.
   * face-api's own default, 0.6, was the old engine's.
   */
  faceThreshold: number;
  /**
   * The liveness challenge at the face clock and its enrolment (2026-10-10,
   * shared/liveness.ts): blink or turn, verified from a burst of frames. Off,
   * no challenge is asked for and none is checked.
   */
  faceLiveness: boolean;
  /** Probation runs this long from dateHired when no period end is set. */
  probationMonths: number;
  /** Months into probation at which an evaluation falls due, before the end one. */
  evaluationMilestoneMonths: number[];
  /** Days before a milestone that HR is told an evaluation is due. */
  evaluationNoticeDays: number;
  /** Ratings run 1..ratingScale; one label per point. */
  ratingScale: number;
  ratingLabels: string[];
  /** Birthday and work-anniversary greetings (2026-10-08) — see shared/celebrations.ts. */
  greetings: GreetingSettings;
}

/**
 * The automatic greetings. Each template may name `{first}`, `{name}`,
 * `{company}`, `{years}` ("5 years" / "1 year" — the age on a birthday) and
 * `{n}` (the bare number). The celebrant gets a bell and an email (where
 * email is set up); everyone else a bell, when `tellEveryone` is on.
 */
export interface GreetingSettings {
  enabled: boolean;
  /** The Manila hour the day's greetings go out from (0–23). */
  hour: number;
  tellEveryone: boolean;
  birthdayTitle: string;
  birthdayMessage: string;
  anniversaryTitle: string;
  anniversaryMessage: string;
  /** The bell everyone else gets. */
  everyoneBirthday: string;
  everyoneAnniversary: string;
}

export const GREETING_DEFAULTS: GreetingSettings = {
  enabled: true,
  hour: 7,
  tellEveryone: true,
  birthdayTitle: 'Happy birthday, {first}!',
  birthdayMessage: 'Everyone at {company} wishes you a wonderful year ahead. Enjoy your day!',
  anniversaryTitle: 'Happy work anniversary, {first} — {years} with {company}!',
  anniversaryMessage: 'Thank you for {years} with {company}. Here is to the next one.',
  everyoneBirthday: "It's {name}'s birthday today — {first} turns {n}",
  everyoneAnniversary: '{name} marks {years} with {company} today',
};

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
  faceThreshold: 0.55,
  faceLiveness: true,
  probationMonths: 6,
  evaluationMilestoneMonths: [3, 5],
  evaluationNoticeDays: 14,
  ratingScale: 5,
  ratingLabels: ['Unsatisfactory', 'Needs improvement', 'Meets expectations', 'Exceeds expectations', 'Outstanding'],
  greetings: GREETING_DEFAULTS,
};

export async function hrSettings(db: Prisma.TransactionClient = prisma): Promise<HrSettings> {
  const row = await db.setting.findUnique({ where: { key: 'hr.rules' } });
  if (!row) return DEFAULTS;
  const stored = row.value as Partial<HrSettings>;
  // The greetings are an object: a stored one from before a new template was
  // added still gets that template's default.
  return { ...DEFAULTS, ...stored, greetings: { ...GREETING_DEFAULTS, ...(stored.greetings ?? {}) } };
}

export async function saveHrSettings(value: Partial<HrSettings>): Promise<HrSettings> {
  const merged = { ...(await hrSettings()), ...value };
  // Prisma's JSON input type wants a plain object; the settings are one.
  const json = JSON.parse(JSON.stringify(merged)) as Prisma.InputJsonObject;
  await prisma.setting.upsert({
    where: { key: 'hr.rules' },
    create: {
      key: 'hr.rules',
      value: json,
      description: 'Working day, breaks, overtime premium and face-match threshold',
    },
    update: { value: json },
  });
  return merged;
}

/**
 * A Setting that holds a list — the clearance checklist, the evaluation
 * criteria. Anything that is not an array (missing row, an older shape)
 * yields the fallback, so a reader never has to guard the JSON itself.
 */
export async function settingList<T>(key: string, fallback: T[]): Promise<T[]> {
  const row = await prisma.setting.findUnique({ where: { key } });
  return Array.isArray(row?.value) ? (row.value as T[]) : fallback;
}

// ── The person behind the login ──────────────────────────────────────────────

/**
 * The employee record behind the signed-in user, if there is one.
 *
 * Employee is the person; User is the login (Phase 2). Every HR route that
 * asks "whose leave, whose overtime, whose clearance" starts here, so what it
 * selects is deliberately small and carries no pay data.
 */
export async function myEmployee(userId: string) {
  return prisma.employee.findUnique({
    where: { userId },
    select: {
      id: true,
      firstName: true,
      lastName: true,
      employeeNo: true,
      isActive: true,
      userId: true,
      departmentId: true,
      positionId: true,
      employmentType: true,
    },
  });
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

/** The business day as a UTC-midnight Date (Manila's, never the server's clock). */
export { dayKey };

// ── Face matching ────────────────────────────────────────────────────────────

/**
 * The gap the claimed person must lead everybody else by. A capture within
 * this of another employee's samples is too close to call, whoever is nearer:
 * the benchmark's wrong-account matches all sat inside it.
 */
export const FACE_MARGIN = 0.05;

/**
 * Current-engine samples a person needs before the clock matches their face.
 * One sample accepted 93% of genuine captures in the benchmark, three 96% —
 * and three is what the Clock page asks for: straight, slightly left,
 * slightly right.
 */
export const MIN_FACE_SAMPLES = 3;

/**
 * The most a person may keep. More samples only widen the net a stranger can
 * fall into; a person whose face has changed removes an old one first.
 */
export const MAX_FACE_SAMPLES = 5;

/**
 * Euclidean distance between two 128-float face descriptors.
 *
 * Lower is a closer match; the threshold (HR Settings, 0.55) says how close is
 * the same person.
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

/** Whether a stored sample was described by the engine this server runs. */
export const isCurrentSample = (row: { engine: string | null }) => row.engine === FACE_ENGINE;

/** A stored descriptor, or null when the row does not hold 128 numbers. */
export function storedDescriptor(value: unknown): number[] | null {
  return Array.isArray(value) && value.length === 128 && value.every((v) => typeof v === 'number')
    ? (value as number[])
    : null;
}

/**
 * Whether the clock can match against a stored sample: the current engine
 * described it AND it holds a readable descriptor. The one test for counting
 * (the three needed, the five allowed, `enrolled`), matching and Face health,
 * so a row the matcher skips is never counted as one it uses.
 */
export const isUsableSample = (row: { engine: string | null; descriptor: unknown }) =>
  isCurrentSample(row) && storedDescriptor(row.descriptor) !== null;

/**
 * How near a capture comes to every active employee who has samples.
 *
 * Per employee it is the MIN distance over their CURRENT-engine samples
 * (`engine === FACE_ENGINE`): a person is as close as their nearest sample.
 * A sample of another engine is LEGACY and takes no part — the same photo
 * through two pipelines differs by ~0.1, a fifth of the threshold — until
 * the boot-time re-derivation (shared/faceSamples.ts) recomputes it.
 *
 * With `claimedEmployeeId`, `own` is that person's distance (null when they
 * have no current sample) and `nearestOther` the closest anybody ELSE comes;
 * `decideFace()` makes the call. `best`/`runnerUp` are the two nearest
 * people overall, kept for scripts that ask "whose face is this".
 *
 * `db` is the transaction to read through — enrolment matches under a lock
 * its transaction holds, and reading on another connection there could wait
 * on the pool behind the very enrolments the lock is holding back.
 */
export async function matchFace(
  descriptor: number[],
  claimedEmployeeId?: string,
  db: Prisma.TransactionClient = prisma,
): Promise<{
  own: number | null;
  nearestOther: FaceMatch | null;
  best: FaceMatch | null;
  runnerUp: FaceMatch | null;
  threshold: number;
}> {
  if (descriptor.length !== 128) {
    throw badRequest('That does not look like a face descriptor — expected 128 values');
  }

  const settings = await hrSettings(db);
  const enrollments = await db.faceEnrollment.findMany({
    where: { engine: FACE_ENGINE, employee: { isActive: true } },
    select: {
      employeeId: true,
      descriptor: true,
      employee: { select: { firstName: true, lastName: true } },
    },
  });

  // Nearest sample per employee.
  const byEmployee = new Map<string, FaceMatch>();
  for (const row of enrollments) {
    const stored = storedDescriptor(row.descriptor);
    if (!stored) continue;
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
  const others = claimedEmployeeId ? ranked.filter((m) => m.employeeId !== claimedEmployeeId) : ranked;
  return {
    own: claimedEmployeeId ? byEmployee.get(claimedEmployeeId)?.distance ?? null : null,
    nearestOther: claimedEmployeeId ? others[0] ?? null : null,
    best: ranked[0] ?? null,
    runnerUp: ranked[1] ?? null,
    threshold: settings.faceThreshold,
  };
}

/** Why the clock refused a face it described. */
export type FaceRefusal = 'not_recognised' | 'not_this_account' | 'unsure';

/**
 * Whether a capture is the person it claims to be — pure, so it is tested
 * without a camera.
 *
 * Accepted only when the claimed person is within the threshold AND leads
 * everybody else by the margin. Otherwise, in this order:
 * - `not_this_account`: someone else is within the threshold and nearer than
 *   the claimed person (or the claimed person is not within it at all) — the
 *   face looks like a colleague's. Checked first: a capture nearer a
 *   colleague is that, even when it also passes for its owner.
 * - `unsure`: the claimed person is within the threshold but somebody else is
 *   within the margin of them — too close to call.
 * - `not_recognised`: nobody is within the threshold.
 */
export function decideFace(input: {
  own: number | null;
  nearestOther: { employeeId: string; name: string; distance: number } | null;
  threshold: number;
  margin: number;
}): { ok: true } | { ok: false; reason: FaceRefusal } {
  const { own, nearestOther, threshold, margin } = input;
  // Boundaries are inclusive, to a hair: 0.45 − 0.40 is 0.04999… in floating
  // point, and a lead of exactly the margin is a lead of the margin.
  const EPS = 1e-9;
  const ownPasses = own != null && own <= threshold + EPS;
  if (ownPasses && (nearestOther == null || nearestOther.distance - own >= margin - EPS)) return { ok: true };

  const otherPasses = nearestOther != null && nearestOther.distance <= threshold + EPS;
  if (otherPasses && (!ownPasses || nearestOther.distance < own!)) return { ok: false, reason: 'not_this_account' };
  if (ownPasses) return { ok: false, reason: 'unsure' };
  return { ok: false, reason: 'not_recognised' };
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

// ── One day of attendance ────────────────────────────────────────────────────

export interface AttendanceDayRow {
  employee: {
    id: string;
    employeeNo: string;
    firstName: string;
    lastName: string;
    position: string | null;
    department: { id: string; name: string } | null;
  };
  status: string;
  timeIn: Date | null;
  timeOut: Date | null;
  lateMinutes: number;
  workedHours: number;
  method: string | null;
  leaveType: string | null;
}

export interface AttendanceDay {
  date: Date;
  headcount: number;
  summary: {
    present: number;
    late: number;
    onLeave: number;
    absent: number;
    halfDay: number;
    pendingApprovals: number;
  };
  rows: AttendanceDayRow[];
}

/**
 * The HR dashboard for one day: present, late, on leave, absent, pending.
 *
 * Absent is derived rather than stored — it is every active employee with no
 * attendance row and no approved leave. Storing it would mean writing a row
 * for everyone every night, and being wrong whenever someone clocks in late.
 *
 * Shared because the Insights brief prints these counts and must agree with
 * the HR dashboard to the person; the day is HR's local `dayKey`, never a
 * UTC one.
 */
export async function attendanceDay(date: Date): Promise<AttendanceDay> {
  const key = dayKey(date);

  const [employees, attendance, onLeave, pendingLeave, pendingOt, pendingEvaluations] = await Promise.all([
    prisma.employee.findMany({
      where: { isActive: true },
      select: {
        id: true,
        employeeNo: true,
        firstName: true,
        lastName: true,
        position: true,
        department: { select: { id: true, name: true } },
      },
      orderBy: { lastName: 'asc' },
    }),
    prisma.attendance.findMany({ where: { date: key } }),
    prisma.leaveRequest.findMany({
      where: { status: 'APPROVED', startDate: { lte: key }, endDate: { gte: key } },
      include: { leaveType: { select: { name: true } } },
    }),
    prisma.leaveRequest.count({ where: { status: 'PENDING_APPROVAL' } }),
    prisma.overtimeRequest.count({ where: { stage: { in: ['PRIOR', 'ACTUAL_FILED'] } } }),
    prisma.employeeEvaluation.count({ where: { status: 'PENDING_APPROVAL' } }),
  ]);

  const attendanceBy = new Map(attendance.map((a) => [a.employeeId, a]));
  const leaveBy = new Map(onLeave.map((l) => [l.employeeId, l]));

  const rows: AttendanceDayRow[] = employees.map((e) => {
    const a = attendanceBy.get(e.id);
    const l = leaveBy.get(e.id);
    const status = a ? a.status : l ? 'ON_LEAVE' : 'ABSENT';
    return {
      employee: e,
      status,
      timeIn: a?.timeIn ?? null,
      timeOut: a?.timeOut ?? null,
      lateMinutes: a?.lateMinutes ?? 0,
      workedHours: a ? Math.round((a.workedMinutes / 60) * 100) / 100 : 0,
      method: a?.timeInMethod ?? null,
      leaveType: l?.leaveType.name ?? null,
    };
  });

  const count = (status: string) => rows.filter((r) => r.status === status).length;

  return {
    date: key,
    headcount: employees.length,
    summary: {
      present: count('PRESENT'),
      late: count('LATE'),
      onLeave: count('ON_LEAVE'),
      absent: count('ABSENT'),
      halfDay: count('HALF_DAY'),
      pendingApprovals: pendingLeave + pendingOt + pendingEvaluations,
    },
    rows,
  };
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
