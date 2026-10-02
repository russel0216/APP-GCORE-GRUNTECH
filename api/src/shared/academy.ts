import { Prisma } from '@prisma/client';
import { prisma } from '../prisma';
import { badRequest, conflict } from '../http/kit';
import { addMonths, expiryState } from './aftermarket';
import { manilaDate, manilaDayKey } from './day';
import { notify } from './notifications';

/**
 * Gruntech Academy (item 13) — the rules more than one route needs.
 *
 * The thing this module exists to make true: **a passport is derived, never
 * kept.** Which courses a person must hold comes from the course
 * requirements (department and/or plantilla position, matched by id); whether
 * they hold one comes from their VERIFIED training records; whether it is
 * current, expiring or expired comes from `expiresAt` against today, through
 * the same `expiryState()` the aftermarket module uses for warranties. No
 * column anywhere says "compliant", so nothing can say it wrongly.
 *
 * Two doors write a record, and only two:
 *   · a session completion (`completeSession`) — final, verified by the
 *     trainer's own completion, no approval step;
 *   · an external certification the employee enters, verified by HR through
 *     the approval engine (`training_certification`), or entered directly by
 *     HR for somebody else.
 */

type Tx = Prisma.TransactionClient | typeof prisma;

export const SESSION_LINK = (id: string) => `/g-hr/academy/sessions/${id}`;
export const PASSPORT_LINK = (employeeId: string) => `/g-hr/academy/passports/${employeeId}`;
export const MY_PASSPORT_LINK = '/g-hr/academy/passport';

// ── Settings ─────────────────────────────────────────────────────────────────

export interface AcademySettings {
  /** How far ahead a certificate counts as "expiring soon", and when its notice goes out. */
  expiryWarningDays: number;
  /** Whether an employee may put themselves on a scheduled session from the calendar. */
  allowSelfEnrolment: boolean;
  /** The course categories offered in the Course form's dropdown. */
  categories: string[];
}

export const ACADEMY_DEFAULTS: AcademySettings = {
  expiryWarningDays: 60,
  allowSelfEnrolment: true,
  categories: ['Safety', 'Technical', 'Quality', 'Compliance', 'Soft skills'],
};

const SETTING_KEY = 'academy.rules';

export async function academySettings(): Promise<AcademySettings> {
  const row = await prisma.setting.findUnique({ where: { key: SETTING_KEY } });
  const value = (row?.value ?? {}) as Partial<AcademySettings>;
  return {
    expiryWarningDays:
      typeof value.expiryWarningDays === 'number' ? value.expiryWarningDays : ACADEMY_DEFAULTS.expiryWarningDays,
    allowSelfEnrolment:
      typeof value.allowSelfEnrolment === 'boolean' ? value.allowSelfEnrolment : ACADEMY_DEFAULTS.allowSelfEnrolment,
    categories: Array.isArray(value.categories) ? value.categories.map(String) : ACADEMY_DEFAULTS.categories,
  };
}

export async function saveAcademySettings(value: Partial<AcademySettings>): Promise<AcademySettings> {
  const merged = { ...(await academySettings()), ...value };
  await prisma.setting.upsert({
    where: { key: SETTING_KEY },
    create: {
      key: SETTING_KEY,
      value: merged as unknown as Prisma.InputJsonValue,
      description: 'Gruntech Academy — expiry warning, self-enrolment and course categories',
    },
    update: { value: merged as unknown as Prisma.InputJsonValue },
  });
  return merged;
}

// ── Dates ────────────────────────────────────────────────────────────────────

/** Where a completion expires: never when the course has no validity. */
export function expiryFor(completedAt: Date, validityMonths: number | null | undefined): Date | null {
  if (validityMonths == null || validityMonths <= 0) return null;
  return addMonths(completedAt, validityMonths);
}

// ── Requirements ─────────────────────────────────────────────────────────────

export interface RequirementRef {
  departmentId: string | null;
  positionId: string | null;
}

export interface EmployeeRef {
  departmentId: string | null;
  positionId: string | null;
}

/**
 * Both null = everyone; department only = everyone in it; position only =
 * every holder of that plantilla position; both = the intersection. Matched
 * by id, never by title — an unclassified employee (no plantilla position)
 * matches department-only and everyone rules, and nothing that names a
 * position.
 */
export function requirementMatches(req: RequirementRef, emp: EmployeeRef): boolean {
  if (req.departmentId && req.departmentId !== emp.departmentId) return false;
  if (req.positionId && req.positionId !== emp.positionId) return false;
  return true;
}

/** The Prisma form of `requirementMatches`, for a query over courses. */
function requirementWhere(emp: EmployeeRef): Prisma.CourseRequirementWhereInput {
  return {
    AND: [
      { OR: [{ departmentId: null }, ...(emp.departmentId ? [{ departmentId: emp.departmentId }] : [])] },
      { OR: [{ positionId: null }, ...(emp.positionId ? [{ positionId: emp.positionId }] : [])] },
    ],
  };
}

const courseSelect = {
  id: true,
  code: true,
  title: true,
  category: true,
  hours: true,
  validityMonths: true,
  requiresAssessment: true,
} satisfies Prisma.CourseSelect;

export type CourseRef = Prisma.CourseGetPayload<{ select: typeof courseSelect }>;

/** The active courses this person must hold. */
export async function requiredCoursesFor(employee: EmployeeRef, tx: Tx = prisma): Promise<CourseRef[]> {
  return tx.course.findMany({
    where: { isActive: true, requirements: { some: requirementWhere(employee) } },
    select: courseSelect,
    orderBy: [{ category: 'asc' }, { code: 'asc' }],
  });
}

// ── One line of a passport ───────────────────────────────────────────────────

/**
 * MISSING — nothing verified on file. PENDING — only an external certificate
 * waiting on HR. CURRENT / EXPIRING / EXPIRED — the best verified record,
 * against today. A course with no validity never expires: CURRENT for good.
 */
export type LineState = 'MISSING' | 'PENDING' | 'CURRENT' | 'EXPIRING' | 'EXPIRED';

export interface RecordLite {
  id: string;
  courseId: string;
  status: 'PENDING_VERIFICATION' | 'VERIFIED' | 'REJECTED';
  completedAt: Date;
  expiresAt: Date | null;
}

/**
 * The record that answers for a course: among VERIFIED ones, the one that
 * lasts longest — a never-expiring one beats any date, a later expiry beats
 * an earlier one, and on a tie the more recent completion. A renewal
 * therefore supersedes the certificate it renews without anybody deleting
 * the old one.
 */
export function bestRecord<T extends RecordLite>(records: T[]): T | null {
  let best: T | null = null;
  for (const r of records) {
    if (r.status !== 'VERIFIED') continue;
    if (!best) {
      best = r;
      continue;
    }
    const a = r.expiresAt?.getTime() ?? Infinity;
    const b = best.expiresAt?.getTime() ?? Infinity;
    if (a > b || (a === b && r.completedAt.getTime() > best.completedAt.getTime())) best = r;
  }
  return best;
}

export interface LineStateResult {
  state: LineState;
  daysRemaining: number | null;
  record: string | null;
}

export function lineState<T extends RecordLite>(
  records: T[],
  warningDays: number,
  asOf = new Date(),
): LineStateResult {
  const best = bestRecord(records);
  if (!best) {
    const pending = records.find((r) => r.status === 'PENDING_VERIFICATION');
    return { state: pending ? 'PENDING' : 'MISSING', daysRemaining: null, record: pending?.id ?? null };
  }
  const e = expiryState(best.expiresAt, warningDays, asOf);
  const state: LineState = e.state === 'EXPIRED' ? 'EXPIRED' : e.state === 'EXPIRING' ? 'EXPIRING' : 'CURRENT';
  return { state, daysRemaining: e.daysRemaining, record: best.id };
}

/** Held = counts toward readiness. An expiring certificate is still valid today. */
export const isHeld = (s: LineState) => s === 'CURRENT' || s === 'EXPIRING';

// ── Readiness (batch) ────────────────────────────────────────────────────────

export interface Readiness {
  required: number;
  held: number;
  expiring: number;
  expired: number;
  missing: number;
  pending: number;
  /** held / required × 100, one decimal; null when nothing is required. */
  pct: number | null;
}

function emptyReadiness(): Readiness {
  return { required: 0, held: 0, expiring: 0, expired: 0, missing: 0, pending: 0, pct: null };
}

/**
 * Readiness for many people in three queries — the requirements, the records
 * and nothing else — so the Passports register and the dashboard tile can
 * never compute it two different ways.
 */
export async function readinessFor(
  employees: { id: string; departmentId: string | null; positionId: string | null }[],
  asOf = new Date(),
  settings?: AcademySettings,
): Promise<Map<string, Readiness>> {
  const out = new Map<string, Readiness>();
  if (!employees.length) return out;
  const rules = settings ?? (await academySettings());

  const courses = await prisma.course.findMany({
    where: { isActive: true, requirements: { some: {} } },
    select: { id: true, requirements: { select: { departmentId: true, positionId: true } } },
  });
  const ids = employees.map((e) => e.id);
  const records = await prisma.trainingRecord.findMany({
    where: {
      employeeId: { in: ids },
      courseId: { in: courses.map((c) => c.id) },
      status: { in: ['VERIFIED', 'PENDING_VERIFICATION'] },
    },
    select: { id: true, employeeId: true, courseId: true, status: true, completedAt: true, expiresAt: true },
  });
  const byKey = new Map<string, typeof records>();
  for (const r of records) {
    const key = `${r.employeeId}|${r.courseId}`;
    const list = byKey.get(key);
    if (list) list.push(r);
    else byKey.set(key, [r]);
  }

  for (const emp of employees) {
    const row = emptyReadiness();
    for (const c of courses) {
      if (!c.requirements.some((req) => requirementMatches(req, emp))) continue;
      row.required++;
      const line = lineState(byKey.get(`${emp.id}|${c.id}`) ?? [], rules.expiryWarningDays, asOf);
      if (isHeld(line.state)) row.held++;
      if (line.state === 'EXPIRING') row.expiring++;
      else if (line.state === 'EXPIRED') row.expired++;
      else if (line.state === 'MISSING') row.missing++;
      else if (line.state === 'PENDING') row.pending++;
    }
    row.pct = row.required ? Math.round((row.held / row.required) * 1000) / 10 : null;
    out.set(emp.id, row);
  }
  return out;
}

export interface TeamReadiness {
  /** Active employees with at least one required course — the denominator. */
  employees: number;
  /** Of those, how many hold every required course today. */
  ready: number;
  /** Required course lines across the company. */
  required: number;
  held: number;
  /** held / required × 100, one decimal; null when nothing is required yet. */
  pct: number | null;
  expiring: number;
  expired: number;
  missing: number;
  /** External certificates waiting on HR. */
  pendingVerification: number;
  /** Scheduled sessions starting in the next 30 days. */
  upcomingSessions: number;
}

/**
 * Company-wide readiness across active employees who must hold at least one
 * course. Somebody with nothing required is neither ready nor unready, so
 * they are left out of the figure rather than inflating it.
 */
export async function teamReadiness(asOf = new Date()): Promise<TeamReadiness> {
  const employees = await prisma.employee.findMany({
    where: { isActive: true },
    select: { id: true, departmentId: true, positionId: true },
  });
  const map = await readinessFor(employees, asOf);
  const out: TeamReadiness = {
    employees: 0,
    ready: 0,
    required: 0,
    held: 0,
    pct: null,
    expiring: 0,
    expired: 0,
    missing: 0,
    pendingVerification: 0,
    upcomingSessions: 0,
  };
  for (const r of map.values()) {
    if (!r.required) continue;
    out.employees++;
    if (r.held === r.required) out.ready++;
    out.required += r.required;
    out.held += r.held;
    out.expiring += r.expiring;
    out.expired += r.expired;
    out.missing += r.missing;
  }
  out.pct = out.required ? Math.round((out.held / out.required) * 1000) / 10 : null;
  const [pending, upcoming] = await Promise.all([
    prisma.trainingRecord.count({ where: { status: 'PENDING_VERIFICATION' } }),
    prisma.trainingSession.count({
      where: { status: 'SCHEDULED', startsAt: { gte: asOf, lt: new Date(asOf.getTime() + 30 * 86_400_000) } },
    }),
  ]);
  out.pendingVerification = pending;
  out.upcomingSessions = upcoming;
  return out;
}

// ── One passport ─────────────────────────────────────────────────────────────

const recordSelect = {
  id: true,
  number: true,
  employeeId: true,
  courseId: true,
  source: true,
  status: true,
  completedAt: true,
  expiresAt: true,
  provider: true,
  certificateNo: true,
  notes: true,
  verifiedAt: true,
  createdAt: true,
  course: { select: courseSelect },
  session: { select: { id: true, number: true } },
  verifiedBy: { select: { id: true, name: true } },
  createdBy: { select: { id: true, name: true } },
} satisfies Prisma.TrainingRecordSelect;

export type PassportRecord = Prisma.TrainingRecordGetPayload<{ select: typeof recordSelect }>;

export interface PassportLine {
  course: Omit<CourseRef, 'hours'> & { hours: number };
  state: LineState;
  daysRemaining: number | null;
  /** The record answering for this line (best verified, else the pending one). */
  recordId: string | null;
  completedAt: Date | null;
  expiresAt: Date | null;
}

/**
 * Everything the passport screen shows: the required lines with their state,
 * and every record on file — required or not, verified, pending or rejected —
 * newest first. Hours are converted at this boundary (rule 10).
 */
export async function passportFor(employeeId: string, asOf = new Date()) {
  const employee = await prisma.employee.findUnique({
    where: { id: employeeId },
    select: {
      id: true,
      employeeNo: true,
      firstName: true,
      lastName: true,
      position: true,
      isActive: true,
      userId: true,
      departmentId: true,
      positionId: true,
      department: { select: { id: true, name: true } },
    },
  });
  if (!employee) return null;
  const rules = await academySettings();
  const [required, records, upcoming] = await Promise.all([
    requiredCoursesFor(employee),
    prisma.trainingRecord.findMany({
      where: { employeeId },
      select: recordSelect,
      orderBy: [{ completedAt: 'desc' }, { createdAt: 'desc' }],
    }),
    prisma.trainingAttendee.findMany({
      where: { employeeId, session: { status: 'SCHEDULED', endsAt: { gte: asOf } } },
      select: {
        session: {
          select: {
            id: true,
            number: true,
            startsAt: true,
            endsAt: true,
            venue: true,
            course: { select: { id: true, code: true, title: true } },
          },
        },
      },
      orderBy: { session: { startsAt: 'asc' } },
    }),
  ]);

  const byCourse = new Map<string, PassportRecord[]>();
  for (const r of records) {
    const list = byCourse.get(r.courseId);
    if (list) list.push(r);
    else byCourse.set(r.courseId, [r]);
  }

  const lines: PassportLine[] = required.map((course) => {
    const list = byCourse.get(course.id) ?? [];
    const s = lineState(list, rules.expiryWarningDays, asOf);
    const rec = s.record ? list.find((r) => r.id === s.record) ?? null : null;
    return {
      course: { ...course, hours: Number(course.hours) },
      state: s.state,
      daysRemaining: s.daysRemaining,
      recordId: s.record,
      completedAt: rec?.completedAt ?? null,
      expiresAt: rec?.expiresAt ?? null,
    };
  });

  const held = lines.filter((l) => isHeld(l.state)).length;
  const requiredIds = new Set(required.map((c) => c.id));
  return {
    employee: {
      id: employee.id,
      employeeNo: employee.employeeNo,
      name: `${employee.firstName} ${employee.lastName}`,
      position: employee.position,
      department: employee.department,
      isActive: employee.isActive,
      userId: employee.userId,
    },
    expiryWarningDays: rules.expiryWarningDays,
    readiness: {
      required: lines.length,
      held,
      expiring: lines.filter((l) => l.state === 'EXPIRING').length,
      expired: lines.filter((l) => l.state === 'EXPIRED').length,
      missing: lines.filter((l) => l.state === 'MISSING').length,
      pending: lines.filter((l) => l.state === 'PENDING').length,
      pct: lines.length ? Math.round((held / lines.length) * 1000) / 10 : null,
    } satisfies Readiness,
    lines,
    records: records.map((r) => {
      const e = r.status === 'VERIFIED' ? expiryState(r.expiresAt, rules.expiryWarningDays, asOf) : null;
      return {
        ...r,
        course: { ...r.course, hours: Number(r.course.hours) },
        required: requiredIds.has(r.courseId),
        expiry: e ? e.state : null,
        daysRemaining: e?.daysRemaining ?? null,
      };
    }),
    upcoming: upcoming.map((a) => a.session),
    totalHours: records
      .filter((r) => r.status === 'VERIFIED')
      .reduce((sum, r) => sum + Number(r.course.hours), 0),
  };
}

// ── Expiry notices (swept on read) ───────────────────────────────────────────

/**
 * Tells each person, once, that a certificate they rely on is about to lapse.
 *
 * Swept when the Academy screens load — G-Core has no scheduler (the Phase 8
 * precedent). Only the record that answers for its course is considered: an
 * old certificate already superseded by a renewal must not nag anybody.
 * `expiryNoticeAt` is the once; editing `expiresAt` resets it, so a corrected
 * date earns its own notice.
 */
export async function sweepExpiryNotices(asOf = new Date()): Promise<number> {
  const rules = await academySettings();
  const horizon = new Date(asOf.getTime() + rules.expiryWarningDays * 86_400_000);
  const due = await prisma.trainingRecord.findMany({
    where: {
      status: 'VERIFIED',
      expiryNoticeAt: null,
      expiresAt: { not: null, lte: horizon, gte: manilaDate(asOf) },
      employee: { isActive: true },
    },
    select: {
      id: true,
      employeeId: true,
      courseId: true,
      expiresAt: true,
      course: { select: { title: true } },
      employee: { select: { userId: true } },
    },
  });
  if (!due.length) return 0;

  const later = await prisma.trainingRecord.findMany({
    where: {
      status: 'VERIFIED',
      OR: due.map((d) => ({
        employeeId: d.employeeId,
        courseId: d.courseId,
        OR: [{ expiresAt: null }, { expiresAt: { gt: d.expiresAt! } }],
      })),
    },
    select: { employeeId: true, courseId: true },
  });
  const superseded = new Set(later.map((l) => `${l.employeeId}|${l.courseId}`));

  const now = new Date();
  let sent = 0;
  for (const d of due) {
    // Claimed row by row, so two screens loading at once send one notice.
    const claimed = await prisma.trainingRecord.updateMany({
      where: { id: d.id, expiryNoticeAt: null },
      data: { expiryNoticeAt: now },
    });
    if (!claimed.count) continue;
    if (superseded.has(`${d.employeeId}|${d.courseId}`) || !d.employee.userId) continue;
    await notify({
      userId: d.employee.userId,
      type: 'training.expiring',
      title: `Expiring: ${d.course.title}`,
      body: `Your certificate lapses on ${manilaDayKey(d.expiresAt!)} — book a refresher before then.`,
      link: MY_PASSPORT_LINK,
    });
    sent++;
  }
  return sent;
}

// ── Completing a session ─────────────────────────────────────────────────────

export const ATTENDEE_RESULTS = ['PENDING', 'PASSED', 'FAILED', 'NO_SHOW'] as const;
export type AttendeeResultValue = (typeof ATTENDEE_RESULTS)[number];

export interface ResultInput {
  employeeId: string;
  result: AttendeeResultValue;
  score?: number | null;
}

/**
 * Writes results onto a session's attendees, inside the caller's transaction.
 * Every id must be on the session; a score is 0-100.
 */
export async function applyResults(
  tx: Prisma.TransactionClient,
  sessionId: string,
  results: ResultInput[],
): Promise<void> {
  if (!results.length) return;
  const attendees = await tx.trainingAttendee.findMany({
    where: { sessionId },
    select: { id: true, employeeId: true },
  });
  const byEmployee = new Map(attendees.map((a) => [a.employeeId, a.id]));
  for (const r of results) {
    const id = byEmployee.get(r.employeeId);
    if (!id) throw badRequest('One of the results is for somebody who is not on this session');
    if (r.score != null && (r.score < 0 || r.score > 100)) throw badRequest('A score is between 0 and 100');
    await tx.trainingAttendee.update({
      where: { id },
      data: {
        result: r.result,
        score: r.score == null ? null : new Prisma.Decimal(r.score),
      },
    });
  }
}

/**
 * Completes a session and writes the passport. Final: there is no approval
 * step, because the trainer completing the session IS the verification — the
 * record is written VERIFIED, by them, dated the day the session ended.
 *
 * Refused while anybody's result is still PENDING, and — for a course that
 * requires an assessment — while a PASSED or FAILED result has no score. Only
 * PASSED attendees get a record; a record per (session, employee) is unique,
 * so completing twice is impossible rather than merely discouraged.
 */
export async function completeSession(
  tx: Prisma.TransactionClient,
  sessionId: string,
  actorId: string,
  asOf = new Date(),
): Promise<{ passed: number; failed: number; noShow: number; records: string[] }> {
  const session = await tx.trainingSession.findUnique({
    where: { id: sessionId },
    select: {
      id: true,
      status: true,
      startsAt: true,
      endsAt: true,
      provider: true,
      courseId: true,
      course: { select: { validityMonths: true, requiresAssessment: true, title: true } },
      attendees: { select: { employeeId: true, result: true, score: true } },
    },
  });
  if (!session) throw badRequest('Session not found');
  if (session.status !== 'SCHEDULED') throw conflict('Only a scheduled session can be completed');
  if (session.startsAt > asOf) throw conflict('A session cannot be completed before it has started');
  if (!session.attendees.length) throw conflict('Nobody is on this session — add the attendees or cancel it');
  const pending = session.attendees.filter((a) => a.result === 'PENDING').length;
  if (pending) throw conflict(`${pending} attendee(s) still have no result — record everyone before completing`);
  if (session.course.requiresAssessment) {
    const unscored = session.attendees.filter(
      (a) => (a.result === 'PASSED' || a.result === 'FAILED') && a.score == null,
    ).length;
    if (unscored) throw conflict(`This course is assessed — ${unscored} attendee(s) need a score`);
  }

  const completedAt = manilaDate(session.endsAt < asOf ? session.endsAt : asOf);
  const expiresAt = expiryFor(completedAt, session.course.validityMonths);
  const now = new Date();
  const passed = session.attendees.filter((a) => a.result === 'PASSED');
  const records: string[] = [];
  for (const a of passed) {
    const rec = await tx.trainingRecord.create({
      data: {
        employeeId: a.employeeId,
        courseId: session.courseId,
        source: 'SESSION',
        sessionId: session.id,
        status: 'VERIFIED',
        completedAt,
        expiresAt,
        provider: session.provider,
        verifiedById: actorId,
        verifiedAt: now,
        createdById: actorId,
      },
      select: { id: true },
    });
    records.push(rec.id);
  }
  await tx.trainingSession.update({
    where: { id: session.id },
    data: { status: 'COMPLETED', completedAt: now },
  });
  return {
    passed: passed.length,
    failed: session.attendees.filter((a) => a.result === 'FAILED').length,
    noShow: session.attendees.filter((a) => a.result === 'NO_SHOW').length,
    records,
  };
}
