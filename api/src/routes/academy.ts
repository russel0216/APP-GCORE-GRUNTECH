import { Router } from 'express';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { prisma } from '../prisma';
import {
  handler,
  parseBody,
  listQuery,
  listResult,
  orderBy,
  idsFilter,
  notFound,
  badRequest,
  forbidden,
  conflict,
  type ListQuery,
} from '../http/kit';
import { authenticate, require_, requireAny, currentUser } from '../auth/middleware';
import { can, canEditRecord, resolveUser, type ResolvedUser } from '../permissions/resolve';
import { env } from '../env';
import { audit } from '../shared/audit';
import { nextNumber } from '../shared/numbering';
import { registerAttachmentGuard } from '../shared/attachments';
import { notify, type NotifyInput } from '../shared/notifications';
import { registerSearch } from '../shared/search';
import { contactPhone, onApprovalSettled, pickWorkflow, submitForApproval } from '../shared/approvals';
import { renderDocument, formatDate, formatDateTime, formatShortDate, statusLabel, type PdfSection, type Signatory } from '../shared/pdf';
import { buildIcs, googleCalendarUrl, parseGoogleLink, timeWindow } from '../shared/calendar-links';
import { myEmployee } from '../shared/hr';
import { manilaDate, manilaDayKey } from '../shared/day';
import { required, optional, decimal, bool, type ImportSpec } from '../shared/csv';
import { registerSchedule } from './workspace';
import type { Registered } from './imports';
import { LIST_CAP, listReference, sendListPdf } from './finance';
import {
  ATTENDEE_RESULTS,
  MY_PASSPORT_LINK,
  PASSPORT_LINK,
  SESSION_LINK,
  academySettings,
  applyResults,
  completeSession,
  expiryFor,
  passportFor,
  readinessFor,
  saveAcademySettings,
  sweepExpiryNotices,
  teamReadiness,
} from '../shared/academy';

/**
 * Gruntech Academy — G-HR › Academy (item 13).
 *
 *   /api/courses            the course master and who must hold each course
 *   /api/training-sessions  schedule, enrol, record results, complete
 *   /api/passports          each person's required-vs-held register
 *   /api/academy-settings   expiry warning, self-enrolment, categories
 *
 * The passport is derived (shared/academy.ts). Two doors write a record: a
 * session completion (final, no approval) and an external certification,
 * which HR verifies through the approval engine as `training_certification`.
 */

const num = (v: Prisma.Decimal | null | undefined) => (v == null ? null : Number(v));
const MAX_CALENDAR_DAYS = 62;
/** A course can run over several days; longer than a fortnight is a typo. */
const MAX_SESSION_HOURS = 24 * 14;

function asDate(v: string | null | undefined, label: string): Date | null {
  if (!v) return null;
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) throw badRequest(`${label} "${v}" is not a date`);
  return d;
}

const fullName = (e: { firstName: string; lastName: string }) => `${e.firstName} ${e.lastName}`;

// ════════════════════════════════════════════════════════════════════
//  COURSES
// ════════════════════════════════════════════════════════════════════

export const courseRoutes = Router();
courseRoutes.use(authenticate);

const courseSchema = z.object({
  code: z
    .string()
    .trim()
    .min(2, 'Give the course a code, e.g. SAF-01')
    .max(30)
    .regex(/^[A-Za-z0-9._-]+$/, 'Letters, numbers, dot, dash and underscore only'),
  title: z.string().trim().min(3, 'Give the course a title').max(200),
  category: z.string().trim().max(60).nullable().optional(),
  description: z.string().trim().max(5000).nullable().optional(),
  hours: z.number().min(0).max(9999).default(0),
  validityMonths: z.number().int().min(1).max(240).nullable().optional(),
  requiresAssessment: z.boolean().default(false),
  isActive: z.boolean().default(true),
});

const requirementSelect = {
  id: true,
  departmentId: true,
  positionId: true,
  department: { select: { id: true, name: true } },
  position: { select: { id: true, code: true, title: true } },
} satisfies Prisma.CourseRequirementSelect;

type RequirementRow = Prisma.CourseRequirementGetPayload<{ select: typeof requirementSelect }>;

/** "Everyone", "Engineering", "Site Safety Officer", "Engineering · Welder". */
function requirementText(r: RequirementRow): string {
  if (!r.department && !r.position) return 'Everyone';
  return [r.department?.name, r.position?.title].filter(Boolean).join(' · ');
}

/**
 * The course list's where-builder — the screen's rows and the printed list
 * read the same set; `?ids=` narrows to the rows ticked.
 */
function courseListWhere(q: ListQuery): Prisma.CourseWhereInput {
  const f = q.filters;
  const and: Prisma.CourseWhereInput[] = [];
  if (f.category) and.push({ category: f.category });
  if (f.active === 'true') and.push({ isActive: true });
  if (f.active === 'false') and.push({ isActive: false });
  if (f.required === 'true') and.push({ requirements: { some: {} } });
  if (f.required === 'false') and.push({ requirements: { none: {} } });
  if (q.search) {
    and.push({
      OR: [
        { code: { contains: q.search, mode: 'insensitive' } },
        { title: { contains: q.search, mode: 'insensitive' } },
        { category: { contains: q.search, mode: 'insensitive' } },
      ],
    });
  }
  const ids = idsFilter(f.ids);
  if (ids) and.push({ id: { in: ids } });
  return { AND: and };
}

const COURSE_SORTS = ['code', 'title', 'category', 'hours', 'validityMonths'];

/** What the list shows of a course, the screen's and the paper's: the counts are read with it. */
const courseListSelect = (now: Date) =>
  ({
    id: true,
    code: true,
    title: true,
    category: true,
    hours: true,
    validityMonths: true,
    requiresAssessment: true,
    isActive: true,
    requirements: { select: requirementSelect },
    _count: {
      select: {
        sessions: { where: { status: 'SCHEDULED', startsAt: { gte: now } } },
        records: { where: { status: 'VERIFIED' } },
      },
    },
  }) satisfies Prisma.CourseSelect;

courseRoutes.get(
  '/',
  require_('ghr.courses.view_all'),
  handler(async (req, res) => {
    const q = listQuery(req);
    const where = courseListWhere(q);
    const [rows, total] = await Promise.all([
      prisma.course.findMany({
        where,
        orderBy: orderBy(q, COURSE_SORTS, { code: 'asc' }),
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
        select: courseListSelect(new Date()),
      }),
      prisma.course.count({ where }),
    ]);
    res.json(
      listResult(
        rows.map(({ requirements, _count, hours, ...c }) => ({
          ...c,
          hours: Number(hours),
          requirementCount: requirements.length,
          requiredOf: requirements.map(requirementText),
          upcomingSessions: _count.sessions,
          completions: _count.records,
        })),
        total,
        q,
      ),
    );
  }),
);

/**
 * The course list on paper — the list as filtered (or the rows ticked),
 * through `courseListWhere`, so the paper is the screen it was printed off:
 * each course, how long, how long it stays valid, who must hold it, what is
 * scheduled and how many hold it now. Declared above `/:id`, or that route
 * swallows it.
 */
courseRoutes.get(
  '/pdf',
  require_('ghr.courses.view_all'),
  handler(async (req, res) => {
    const q = listQuery(req);
    const where = courseListWhere(q);
    const f = q.filters;
    const [rows, count] = await Promise.all([
      prisma.course.findMany({
        where,
        orderBy: orderBy(q, COURSE_SORTS, { code: 'asc' }),
        take: LIST_CAP,
        select: courseListSelect(new Date()),
      }),
      prisma.course.count({ where }),
    ]);
    const reference = listReference(count, rows.length, ['course', 'courses'], [
      q.search && `search "${q.search}"`,
      f.active === 'true' && 'active',
      f.active === 'false' && 'inactive',
      f.category && `category ${f.category}`,
      f.required === 'true' && 'required of somebody',
      f.required === 'false' && 'optional',
      f.ids && 'the rows selected',
    ]);

    // Eight columns: landscape (rule 6).
    const pdf = await renderDocument({
      title: 'Courses',
      date: new Date(),
      reference,
      landscape: true,
      sections: [
        {
          kind: 'table',
          head: ['Code', 'Course', 'Hours', 'Valid for', 'Required of', 'Upcoming', 'Certified', 'Status'],
          align: ['left', 'left', 'right', 'left', 'left', 'right', 'right', 'left'],
          rows: rows.map((c) => [
            c.code,
            {
              title: c.title,
              body: [c.category ?? 'Uncategorised', c.requiresAssessment ? 'assessed' : null].filter(Boolean).join(' · '),
            },
            String(Number(c.hours)),
            c.validityMonths ? `${c.validityMonths} months` : 'Never expires',
            c.requirements.length ? c.requirements.map(requirementText).join('; ') : 'Nobody — optional',
            String(c._count.sessions),
            String(c._count.records),
            c.isActive ? 'Active' : 'Inactive',
          ]),
        },
      ],
    });
    await audit(
      { entityType: 'course', entityId: 'list', action: 'EXPORTED', summary: `Exported the course list as PDF (${rows.length} course(s))` },
      req,
    );
    sendListPdf(res, pdf, 'courses.pdf');
  }),
);

/** The course picker on a session and on an external certificate. */
courseRoutes.get(
  '/lookup',
  requireAny(
    'ghr.courses.view_all',
    'ghr.training_sessions.create',
    'ghr.training_sessions.edit_all',
    'ghr.passport.create',
    'ghr.passports.create',
  ),
  handler(async (_req, res) => {
    const rows = await prisma.course.findMany({
      where: { isActive: true },
      orderBy: [{ category: 'asc' }, { code: 'asc' }],
      select: {
        id: true,
        code: true,
        title: true,
        category: true,
        hours: true,
        validityMonths: true,
        requiresAssessment: true,
      },
    });
    res.json(rows.map((c) => ({ ...c, hours: Number(c.hours) })));
  }),
);

async function loadCourse(id: string) {
  const course = await prisma.course.findUnique({
    where: { id },
    select: {
      id: true,
      code: true,
      title: true,
      category: true,
      description: true,
      hours: true,
      validityMonths: true,
      requiresAssessment: true,
      isActive: true,
      createdAt: true,
      updatedAt: true,
      requirements: { select: requirementSelect, orderBy: { createdAt: 'asc' } },
      _count: { select: { sessions: true, records: true } },
    },
  });
  if (!course) throw notFound('Course not found');
  return {
    ...course,
    hours: Number(course.hours),
    requirements: course.requirements.map((r) => ({ ...r, label: requirementText(r) })),
  };
}

courseRoutes.get(
  '/:id',
  require_('ghr.courses.view_all'),
  handler(async (req, res) => {
    res.json(await loadCourse(req.params.id));
  }),
);

function courseData(body: z.infer<typeof courseSchema>) {
  return {
    code: body.code.toUpperCase(),
    title: body.title,
    category: body.category || null,
    description: body.description || null,
    hours: new Prisma.Decimal(body.hours),
    validityMonths: body.validityMonths ?? null,
    requiresAssessment: body.requiresAssessment,
    isActive: body.isActive,
  };
}

async function assertCodeFree(code: string, exceptId?: string) {
  const clash = await prisma.course.findFirst({
    where: { code: { equals: code, mode: 'insensitive' }, ...(exceptId ? { NOT: { id: exceptId } } : {}) },
    select: { id: true },
  });
  if (clash) throw conflict(`Course code ${code.toUpperCase()} is already used`);
}

courseRoutes.post(
  '/',
  require_('ghr.courses.create'),
  handler(async (req, res) => {
    const body = parseBody(courseSchema, req.body);
    await assertCodeFree(body.code);
    const course = await prisma.course.create({ data: courseData(body), select: { id: true, code: true, title: true } });
    await audit(
      {
        entityType: 'course',
        entityId: course.id,
        action: 'CREATED',
        summary: `${course.code} ${course.title}`,
        after: { ...body },
      },
      req,
    );
    res.status(201).json(await loadCourse(course.id));
  }),
);

/**
 * Changing a course's validity does not rewrite an expiry already on file:
 * a certificate expires on the date it was issued with. The new validity
 * applies from the next completion.
 */
courseRoutes.patch(
  '/:id',
  require_('ghr.courses.edit_all'),
  handler(async (req, res) => {
    const before = await loadCourse(req.params.id);
    const body = parseBody(courseSchema.partial(), req.body);
    if (body.code) await assertCodeFree(body.code, before.id);
    const data: Prisma.CourseUpdateInput = {};
    if (body.code !== undefined) data.code = body.code.toUpperCase();
    if (body.title !== undefined) data.title = body.title;
    if (body.category !== undefined) data.category = body.category || null;
    if (body.description !== undefined) data.description = body.description || null;
    if (body.hours !== undefined) data.hours = new Prisma.Decimal(body.hours);
    if (body.validityMonths !== undefined) data.validityMonths = body.validityMonths ?? null;
    if (body.requiresAssessment !== undefined) data.requiresAssessment = body.requiresAssessment;
    if (body.isActive !== undefined) data.isActive = body.isActive;
    await prisma.course.update({ where: { id: before.id }, data });
    const after = await loadCourse(before.id);
    await audit(
      {
        entityType: 'course',
        entityId: before.id,
        action: 'UPDATED',
        summary: `${after.code}: ${Object.keys(data).join(', ')} changed`,
        before: {
          code: before.code,
          title: before.title,
          hours: before.hours,
          validityMonths: before.validityMonths,
          isActive: before.isActive,
        },
        after: {
          code: after.code,
          title: after.title,
          hours: after.hours,
          validityMonths: after.validityMonths,
          isActive: after.isActive,
        },
      },
      req,
    );
    res.json(after);
  }),
);

const requirementRow = z.object({
  departmentId: z.string().min(1).nullable().optional(),
  positionId: z.string().min(1).nullable().optional(),
});

/**
 * Replaces the whole requirement list — the form edits it as one table.
 * Takes `[{ departmentId?, positionId? }]` (or `{ requirements: [...] }`).
 * Both empty on a row means everyone.
 */
courseRoutes.put(
  '/:id/requirements',
  require_('ghr.courses.edit_all'),
  handler(async (req, res) => {
    const before = await loadCourse(req.params.id);
    const raw = Array.isArray(req.body) ? req.body : (req.body as { requirements?: unknown })?.requirements;
    const rows = parseBody(z.array(requirementRow).max(100), raw ?? []);

    const seen = new Set<string>();
    const unique: { departmentId: string | null; positionId: string | null }[] = [];
    for (const r of rows) {
      const row = { departmentId: r.departmentId ?? null, positionId: r.positionId ?? null };
      const key = `${row.departmentId}|${row.positionId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      unique.push(row);
    }
    const deptIds = [...new Set(unique.map((r) => r.departmentId).filter((x): x is string => !!x))];
    const posIds = [...new Set(unique.map((r) => r.positionId).filter((x): x is string => !!x))];
    const [depts, positions] = await Promise.all([
      prisma.department.count({ where: { id: { in: deptIds } } }),
      prisma.position.count({ where: { id: { in: posIds } } }),
    ]);
    if (depts !== deptIds.length) throw badRequest('One of the departments no longer exists');
    if (positions !== posIds.length) throw badRequest('One of the plantilla positions no longer exists');

    await prisma.$transaction(async (tx) => {
      await tx.courseRequirement.deleteMany({ where: { courseId: before.id } });
      if (unique.length) {
        await tx.courseRequirement.createMany({
          data: unique.map((r) => ({ courseId: before.id, ...r })),
        });
      }
    });
    const after = await loadCourse(before.id);
    await audit(
      {
        entityType: 'course',
        entityId: before.id,
        action: 'UPDATED',
        summary: `${after.code}: required of ${after.requirements.map((r) => r.label).join('; ') || 'nobody'}`,
        before: { requirements: before.requirements.map((r) => r.label) },
        after: { requirements: after.requirements.map((r) => r.label) },
      },
      req,
    );
    res.json(after);
  }),
);

/** A course anybody has trained on is history — deactivate it instead. */
courseRoutes.delete(
  '/:id',
  require_('ghr.courses.delete'),
  handler(async (req, res) => {
    const course = await loadCourse(req.params.id);
    if (course._count.sessions || course._count.records) {
      throw conflict(
        `${course.code} has ${course._count.sessions} session(s) and ${course._count.records} training record(s) — deactivate it instead`,
      );
    }
    await prisma.course.delete({ where: { id: course.id } });
    await audit(
      { entityType: 'course', entityId: course.id, action: 'DELETED', summary: `${course.code} ${course.title}` },
      req,
    );
    res.status(204).end();
  }),
);

// ── CSV import (wired by the orchestrator as REGISTRY.courses) ──────────────

interface CourseImportRecord {
  code: string;
  title: string;
  category: string | null;
  description: string | null;
  hours: number;
  validityMonths: number | null;
  requiresAssessment: boolean;
  isActive: boolean;
}

const courseSpec: ImportSpec<CourseImportRecord> = {
  entity: 'courses',
  label: 'Courses',
  columns: [
    { header: 'Code', required: true, example: 'SAF-01', hint: 'Unique; an existing code is updated' },
    { header: 'Title', required: true, example: 'Basic Occupational Safety and Health' },
    { header: 'Category', example: 'Safety' },
    { header: 'Description', example: '' },
    { header: 'Hours', example: '8' },
    { header: 'Validity Months', example: '24', hint: 'Blank = never expires' },
    { header: 'Requires Assessment', example: 'No' },
    { header: 'Active', example: 'Yes' },
  ],
  existing: async (row) => {
    if (!row['Code']) return null;
    const found = await prisma.course.findFirst({
      where: { code: { equals: row['Code'], mode: 'insensitive' } },
      select: { id: true },
    });
    return found?.id ?? null;
  },
  build: async (row) => {
    const code = required(row, 'Code').toUpperCase();
    if (!/^[A-Z0-9._-]{2,30}$/.test(code)) throw new Error(`Code "${code}" — letters, numbers, dot, dash, underscore`);
    const hours = decimal(row, 'Hours') ?? 0;
    if (hours < 0) throw new Error('Hours cannot be negative');
    const validity = decimal(row, 'Validity Months');
    if (validity != null && (!Number.isInteger(validity) || validity < 1)) {
      throw new Error('Validity Months is a whole number of months, or blank');
    }
    return {
      code,
      title: required(row, 'Title'),
      category: optional(row, 'Category'),
      description: optional(row, 'Description'),
      hours,
      validityMonths: validity,
      requiresAssessment: bool(row, 'Requires Assessment', false),
      isActive: bool(row, 'Active'),
    };
  },
};

export const courseImport: Registered = {
  spec: courseSpec as unknown as ImportSpec<never>,
  permission: 'ghr.courses.create',
  write: async (records) => {
    for (const { record, existingId } of records as unknown as {
      record: CourseImportRecord;
      existingId: string | null;
    }[]) {
      const data = { ...record, hours: new Prisma.Decimal(record.hours) };
      if (existingId) await prisma.course.update({ where: { id: existingId }, data });
      else await prisma.course.create({ data });
    }
  },
};

// ════════════════════════════════════════════════════════════════════
//  TRAINING SESSIONS
// ════════════════════════════════════════════════════════════════════

export const sessionRoutes = Router();
sessionRoutes.use(authenticate);

const SESSION_VIEW = ['ghr.training_sessions.view_all', 'ghr.training_sessions.view_own'];
/** The training calendar is company-wide: every session, to anybody holding it. */
const CALENDAR_VIEW = ['ghr.training_calendar.view_all', ...SESSION_VIEW];

/** Trainer, creator or attendee — the sessions that are somebody's own. */
function participantWhere(userId: string): Prisma.TrainingSessionWhereInput {
  return {
    OR: [{ trainerId: userId }, { createdById: userId }, { attendees: { some: { employee: { userId } } } }],
  };
}

/** Who may open a session: the calendar is company-wide, so its holders see all. */
function visibleWhere(user: ResolvedUser): Prisma.TrainingSessionWhereInput {
  if (can(user, 'ghr.training_sessions.view_all') || can(user, 'ghr.training_calendar.view_all')) return {};
  return participantWhere(user.id);
}

const person = { select: { id: true, name: true, email: true, position: true } };

const detailSelect = {
  id: true,
  number: true,
  status: true,
  courseId: true,
  course: {
    select: {
      id: true,
      code: true,
      title: true,
      category: true,
      description: true,
      hours: true,
      validityMonths: true,
      requiresAssessment: true,
    },
  },
  trainerId: true,
  trainer: person,
  provider: true,
  startsAt: true,
  endsAt: true,
  venue: true,
  meetLink: true,
  capacity: true,
  notes: true,
  icsSequence: true,
  completedAt: true,
  cancelReason: true,
  createdById: true,
  createdBy: { select: { id: true, name: true } },
  createdAt: true,
  updatedAt: true,
  attendees: {
    select: {
      id: true,
      employeeId: true,
      result: true,
      score: true,
      enrolledAt: true,
      enrolledById: true,
      enrolledBy: { select: { id: true, name: true } },
      employee: {
        select: {
          id: true,
          employeeNo: true,
          firstName: true,
          lastName: true,
          position: true,
          userId: true,
          department: { select: { id: true, name: true } },
          user: { select: { email: true } },
        },
      },
    },
    orderBy: [{ employee: { lastName: 'asc' } }, { employee: { firstName: 'asc' } }],
  },
  _count: { select: { records: true } },
} satisfies Prisma.TrainingSessionSelect;

type SessionDetail = Prisma.TrainingSessionGetPayload<{ select: typeof detailSelect }>;

async function loadVisible(id: string, user: ResolvedUser): Promise<SessionDetail> {
  const s = await prisma.trainingSession.findFirst({ where: { id, ...visibleWhere(user) }, select: detailSelect });
  if (!s) throw notFound('Training session not found');
  return s;
}

function canEditSession(user: ResolvedUser, s: { trainerId: string }): boolean {
  return canEditRecord(user, 'ghr', 'training_sessions', s.trainerId);
}

/** Ownership is the trainer (rule 7). A completed or cancelled session is history. */
function assertCanEdit(user: ResolvedUser, s: { trainerId: string; status: string }): void {
  if (!canEditSession(user, s)) throw forbidden('Only the trainer can change this session');
  if (s.status === 'COMPLETED') throw conflict('This session is completed — its results are final');
  if (s.status === 'CANCELLED') throw conflict('This session was cancelled — schedule a new one instead');
}

function sessionCalendarInput(s: {
  id: string;
  number: string;
  course: { title: string; description?: string | null };
  venue: string | null;
  meetLink: string | null;
  startsAt: Date;
  endsAt: Date;
  icsSequence: number;
  status: string;
  notes?: string | null;
}) {
  const description = [s.course.description, s.notes, s.meetLink ? `Join: ${s.meetLink}` : null]
    .filter(Boolean)
    .join('\n\n');
  return {
    uid: s.id,
    number: s.number,
    title: `Training: ${s.course.title}`,
    description: description || null,
    location: s.venue ?? (s.meetLink ? 'Google Meet' : null),
    startsAt: s.startsAt,
    endsAt: s.endsAt,
    sequence: s.icsSequence,
    cancelled: s.status === 'CANCELLED',
    url: SESSION_LINK(s.id),
  };
}

/** Join opens 15 minutes before the start and closes at the end. */
function isLive(s: { startsAt: Date; endsAt: Date; status: string }, now = new Date()): boolean {
  return (
    s.status === 'SCHEDULED' &&
    now.getTime() >= s.startsAt.getTime() - 15 * 60_000 &&
    now.getTime() <= s.endsAt.getTime()
  );
}

/**
 * The record as the page reads it. Results are the trainer's and HR's
 * business: somebody who can see the session only because the calendar is
 * company-wide sees who is going, and their own result, never a colleague's.
 */
async function present(s: SessionDetail, user: ResolvedUser) {
  const canEdit = s.status === 'SCHEDULED' && canEditSession(user, s);
  const seesResults =
    can(user, 'ghr.training_sessions.view_all') ||
    s.trainerId === user.id ||
    canEditSession(user, s) ||
    can(user, 'ghr.passports.view_all');
  const rules = await academySettings();
  const me = s.attendees.find((a) => a.employee.userId === user.id) ?? null;
  const myEmp = me ? null : await myEmployee(user.id);
  const full = s.capacity != null && s.attendees.length >= s.capacity;
  const guests = s.attendees.filter((a) => a.employee.user?.email).map((a) => ({ email: a.employee.user!.email }));
  return {
    ...s,
    course: { ...s.course, hours: Number(s.course.hours) },
    attendees: s.attendees.map((a) => {
      const own = a.employee.userId === user.id;
      const { user: _u, ...employee } = a.employee;
      void _u;
      return {
        id: a.id,
        employeeId: a.employeeId,
        employee,
        enrolledAt: a.enrolledAt,
        selfEnrolled: a.enrolledById === null,
        enrolledBy: a.enrolledBy,
        result: seesResults || own ? a.result : null,
        score: seesResults || own ? num(a.score) : null,
      };
    }),
    recordCount: s._count.records,
    canEdit,
    seesResults,
    live: isLive(s),
    isTrainer: s.trainerId === user.id,
    enrolled: me !== null,
    myResult: me?.result ?? null,
    full,
    canSelfEnrol:
      rules.allowSelfEnrolment &&
      s.status === 'SCHEDULED' &&
      s.startsAt > new Date() &&
      !me &&
      !full &&
      !!myEmp?.isActive,
    canWithdraw: !!me && me.enrolledById === null && s.status === 'SCHEDULED' && s.startsAt > new Date(),
    googleCalendarUrl:
      canEdit && !s.meetLink ? googleCalendarUrl(sessionCalendarInput(s), guests, env.appUrl) : null,
  };
}

/** Active employees among the ids named — refuses anybody inactive or unknown. */
async function enrollableEmployees(ids: string[]): Promise<{ id: string; userId: string | null }[]> {
  const unique = [...new Set(ids)];
  if (!unique.length) return [];
  const rows = await prisma.employee.findMany({
    where: { id: { in: unique }, isActive: true },
    select: { id: true, userId: true },
  });
  if (rows.length !== unique.length) throw badRequest('One of the people named is not an active employee');
  return rows;
}

/** The trainer must hold the Trainer right — role or override, not a DENY. */
async function assertTrainer(userId: string): Promise<ResolvedUser> {
  const trainer = await resolveUser(userId);
  if (!trainer) throw badRequest('The trainer is not an active user');
  if (!can(trainer, 'ghr.training_sessions.create')) {
    throw badRequest(`${trainer.name} does not hold the Trainer right (ghr.training_sessions.create)`);
  }
  return trainer;
}

const dateTimeFmt = new Intl.DateTimeFormat('en-PH', {
  timeZone: 'Asia/Manila',
  month: 'short',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
});
const timeOnly = new Intl.DateTimeFormat('en-PH', { timeZone: 'Asia/Manila', hour: '2-digit', minute: '2-digit' });
/** A clock time on paper, in Manila: "9:00 AM". */
const clockFmt = new Intl.DateTimeFormat('en-PH', { timeZone: 'Asia/Manila', hour: 'numeric', minute: '2-digit', hour12: true });
const whenText = (s: Date, e: Date) =>
  manilaDayKey(s) === manilaDayKey(e)
    ? `${dateTimeFmt.format(s)} – ${timeOnly.format(e)}`
    : `${dateTimeFmt.format(s)} – ${dateTimeFmt.format(e)}`;

// ── Calendar ────────────────────────────────────────────────────────────────

sessionRoutes.get(
  '/calendar',
  requireAny(...CALENDAR_VIEW),
  handler(async (req, res) => {
    const me = currentUser(req);
    const from = new Date(String(req.query.from ?? ''));
    const to = new Date(String(req.query.to ?? ''));
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) throw badRequest('from and to must be timestamps');
    if (to <= from) throw badRequest('to must be after from');
    if (to.getTime() - from.getTime() > MAX_CALENDAR_DAYS * 86_400_000) {
      throw badRequest(`A calendar window is at most ${MAX_CALENDAR_DAYS} days`);
    }
    const and: Prisma.TrainingSessionWhereInput[] = [visibleWhere(me), { startsAt: { gte: from, lt: to } }];
    if (typeof req.query.courseId === 'string' && req.query.courseId) and.push({ courseId: req.query.courseId });
    if (req.query.cancelled !== 'true') and.push({ status: { not: 'CANCELLED' } });
    const rows = await prisma.trainingSession.findMany({
      where: { AND: and },
      orderBy: { startsAt: 'asc' },
      select: {
        id: true,
        number: true,
        status: true,
        startsAt: true,
        endsAt: true,
        venue: true,
        meetLink: true,
        capacity: true,
        trainerId: true,
        trainer: { select: { name: true } },
        course: { select: { id: true, code: true, title: true, category: true } },
        attendees: { select: { employee: { select: { userId: true } } } },
      },
    });
    res.json(
      rows.map((s) => ({
        id: s.id,
        number: s.number,
        status: s.status,
        date: manilaDayKey(s.startsAt),
        sortAt: s.startsAt.getTime(),
        time: timeOnly.format(s.startsAt),
        label: s.course.title,
        detail: [s.course.code, s.venue ?? (s.meetLink ? 'Google Meet' : null), s.trainer.name].filter(Boolean).join(' · '),
        done: s.status !== 'SCHEDULED',
        startsAt: s.startsAt,
        endsAt: s.endsAt,
        venue: s.venue,
        course: s.course,
        trainerName: s.trainer.name,
        capacity: s.capacity,
        enrolledCount: s.attendees.length,
        enrolledMe: s.attendees.some((a) => a.employee.userId === me.id),
        isTrainer: s.trainerId === me.id,
        link: SESSION_LINK(s.id),
      })),
    );
  }),
);

// ── List ────────────────────────────────────────────────────────────────────

/**
 * The session list's where-builder — the screen's rows and the printed list
 * read the same set. Without `view_all` a person sees the sessions they
 * train, scheduled or attend; `?ids=` narrows to the rows ticked, ANDed with
 * that rule.
 */
function sessionListWhere(me: ResolvedUser, q: ListQuery): Prisma.TrainingSessionWhereInput {
  const f = q.filters;
  const and: Prisma.TrainingSessionWhereInput[] = [];
  if (!can(me, 'ghr.training_sessions.view_all')) and.push(participantWhere(me.id));
  if (q.scope === 'mine') and.push({ trainerId: me.id });
  if (f.status && ['SCHEDULED', 'COMPLETED', 'CANCELLED'].includes(f.status)) {
    and.push({ status: f.status as 'SCHEDULED' | 'COMPLETED' | 'CANCELLED' });
  }
  const now = new Date();
  if (f.when === 'upcoming') and.push({ endsAt: { gte: now } });
  if (f.when === 'past') and.push({ endsAt: { lt: now } });
  if (f.when === 'to_complete') and.push({ status: 'SCHEDULED', startsAt: { lt: now } });
  if (f.courseId) and.push({ courseId: f.courseId });
  if (f.trainerId) and.push({ trainerId: f.trainerId });
  if (q.search) {
    and.push({
      OR: [
        { number: { contains: q.search, mode: 'insensitive' } },
        { venue: { contains: q.search, mode: 'insensitive' } },
        { provider: { contains: q.search, mode: 'insensitive' } },
        { course: { title: { contains: q.search, mode: 'insensitive' } } },
        { course: { code: { contains: q.search, mode: 'insensitive' } } },
        { trainer: { name: { contains: q.search, mode: 'insensitive' } } },
      ],
    });
  }
  const ids = idsFilter(f.ids);
  if (ids) and.push({ id: { in: ids } });
  return { AND: and };
}

const SESSION_SORTS = ['startsAt', 'number', 'status'];
const sessionFallbackSort = (q: ListQuery): Record<string, 'asc' | 'desc'> =>
  q.filters.when === 'upcoming' ? { startsAt: 'asc' } : { startsAt: 'desc' };

sessionRoutes.get(
  '/',
  requireAny(...SESSION_VIEW),
  handler(async (req, res) => {
    const me = currentUser(req);
    const q = listQuery(req);
    const where = sessionListWhere(me, q);
    const [rows, total] = await Promise.all([
      prisma.trainingSession.findMany({
        where,
        orderBy: orderBy(q, SESSION_SORTS, sessionFallbackSort(q)),
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
        select: {
          id: true,
          number: true,
          status: true,
          startsAt: true,
          endsAt: true,
          venue: true,
          meetLink: true,
          capacity: true,
          provider: true,
          trainerId: true,
          trainer: { select: { id: true, name: true } },
          course: { select: { id: true, code: true, title: true } },
          attendees: { select: { result: true } },
        },
      }),
      prisma.trainingSession.count({ where }),
    ]);
    res.json(
      listResult(
        rows.map(({ attendees, ...s }) => ({
          ...s,
          attendeeCount: attendees.length,
          passedCount: attendees.filter((a) => a.result === 'PASSED').length,
          isTrainer: s.trainerId === me.id,
        })),
        total,
        q,
      ),
    );
  }),
);

const SESSION_WHEN_NAMED: Record<string, string> = {
  upcoming: 'upcoming',
  past: 'past',
  to_complete: 'waiting to be completed',
};

/**
 * The session list on paper — the list as filtered (or the rows ticked),
 * through `sessionListWhere`, so the paper is the screen it was printed
 * off: when, which course, where, who trains it, how many are on it (and
 * passed, once completed) and where it stands. Who attended by name, with
 * their results, is the session's own attendance sheet. Declared above
 * `/:id`, or that route swallows it.
 */
sessionRoutes.get(
  '/pdf',
  requireAny(...SESSION_VIEW),
  handler(async (req, res) => {
    const me = currentUser(req);
    const q = listQuery(req);
    const where = sessionListWhere(me, q);
    const f = q.filters;
    const [rows, count, course, trainer] = await Promise.all([
      prisma.trainingSession.findMany({
        where,
        orderBy: orderBy(q, SESSION_SORTS, sessionFallbackSort(q)),
        take: LIST_CAP,
        select: {
          number: true,
          status: true,
          startsAt: true,
          endsAt: true,
          venue: true,
          meetLink: true,
          capacity: true,
          provider: true,
          trainer: { select: { name: true } },
          course: { select: { code: true, title: true } },
          attendees: { select: { result: true } },
        },
      }),
      prisma.trainingSession.count({ where }),
      f.courseId ? prisma.course.findUnique({ where: { id: f.courseId }, select: { code: true } }) : null,
      f.trainerId ? prisma.user.findUnique({ where: { id: f.trainerId }, select: { name: true } }) : null,
    ]);
    const reference = listReference(count, rows.length, ['training session', 'training sessions'], [
      q.search && `search "${q.search}"`,
      f.when && SESSION_WHEN_NAMED[f.when],
      f.status && ['SCHEDULED', 'COMPLETED', 'CANCELLED'].includes(f.status) && `status ${statusLabel(f.status)}`,
      f.courseId && `course ${course?.code ?? 'not found'}`,
      f.trainerId && `trainer ${trainer?.name ?? 'not found'}`,
      q.scope === 'mine' && 'mine only',
      f.ids && 'the rows selected',
    ]);
    const clock = (d: Date) => clockFmt.format(d).replace(/\s+/g, ' ').toUpperCase();

    // Eight columns: landscape (rule 6).
    const pdf = await renderDocument({
      title: 'Training Sessions',
      date: new Date(),
      reference,
      landscape: true,
      sections: [
        {
          kind: 'table',
          head: ['Number', 'Course', 'Date', 'Time', 'Where', 'Trainer', 'People', 'Status'],
          align: ['left', 'left', 'left', 'left', 'left', 'left', 'right', 'left'],
          rows: rows.map((s) => {
            const sameDay = manilaDayKey(s.startsAt) === manilaDayKey(s.endsAt);
            const passed = s.attendees.filter((a) => a.result === 'PASSED').length;
            const people =
              s.status === 'COMPLETED' ? `${passed} of ${s.attendees.length} passed` : String(s.attendees.length);
            return [
              s.number,
              { title: s.course.title, body: s.course.code },
              formatShortDate(s.startsAt),
              sameDay
                ? `${clock(s.startsAt)} – ${clock(s.endsAt)}`
                : `${clock(s.startsAt)} – ${formatShortDate(s.endsAt)} ${clock(s.endsAt)}`,
              s.venue ?? (s.meetLink ? 'Google Meet' : '—'),
              s.provider ? { title: s.trainer.name, body: s.provider } : s.trainer.name,
              s.capacity ? { title: people, body: `of ${s.capacity} places` } : people,
              statusLabel(s.status),
            ];
          }),
        },
      ],
    });
    await audit(
      { entityType: 'training_session', entityId: 'list', action: 'EXPORTED', summary: `Exported the training session list as PDF (${rows.length} session(s))` },
      req,
    );
    sendListPdf(res, pdf, 'training-sessions.pdf');
  }),
);

// ── One ─────────────────────────────────────────────────────────────────────

sessionRoutes.get(
  '/:id',
  requireAny(...CALENDAR_VIEW),
  handler(async (req, res) => {
    const me = currentUser(req);
    res.json(await present(await loadVisible(req.params.id, me), me));
  }),
);

/** The `.ics` — the same builder the meetings use. Audited: it is an export. */
sessionRoutes.get(
  '/:id/ics',
  requireAny(...CALENDAR_VIEW),
  handler(async (req, res) => {
    const me = currentUser(req);
    const s = await loadVisible(req.params.id, me);
    const ics = buildIcs(
      sessionCalendarInput(s),
      { name: s.trainer.name, email: s.trainer.email },
      s.attendees
        .filter((a) => a.employee.user?.email)
        .map((a) => ({ name: fullName(a.employee), email: a.employee.user!.email, required: true })),
      env.appUrl,
    );
    await audit(
      { entityType: 'training_session', entityId: s.id, action: 'EXPORTED', summary: `${s.number} downloaded as .ics` },
      req,
    );
    res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${s.number}.ics"`);
    res.send(ics);
  }),
);

/** The attendance sheet — through renderDocument, like every printable document. */
sessionRoutes.get(
  '/:id/pdf',
  requireAny(...SESSION_VIEW),
  handler(async (req, res) => {
    const me = currentUser(req);
    const s = await loadVisible(req.params.id, me);
    if (!can(me, 'ghr.training_sessions.view_all') && !canEditSession(me, s) && s.trainerId !== me.id) {
      throw forbidden('Only the trainer or HR can print the attendance sheet');
    }
    const sections: PdfSection[] = [
      {
        kind: 'fields',
        columns: 2,
        fields: [
          { label: 'Course', value: `${s.course.code} — ${s.course.title}` },
          { label: 'Category', value: s.course.category ?? '—' },
          { label: 'When', value: `${formatDateTime(s.startsAt)} – ${formatDateTime(s.endsAt)}` },
          { label: 'Venue', value: s.venue ?? (s.meetLink ? `Online — ${s.meetLink}` : '—') },
          { label: 'Trainer', value: s.trainer.name },
          { label: 'Provider', value: s.provider ?? 'In-house' },
          { label: 'Hours', value: String(Number(s.course.hours)) },
          {
            label: 'Status',
            value:
              s.status === 'COMPLETED'
                ? `${statusLabel(s.status)} ${formatDate(s.completedAt ?? s.endsAt)}`
                : s.status === 'CANCELLED' && s.cancelReason
                  ? `${statusLabel(s.status)} — ${s.cancelReason}`
                  : statusLabel(s.status),
          },
        ],
      },
      {
        kind: 'table',
        title: `Attendees (${s.attendees.length})`,
        // No widths: each column from what it holds, so a head never breaks
        // mid-word ("SCOR / E" did in fixed shares). "No." counts the lines;
        // "Number" is the employee's.
        head: ['No.', 'Number', 'Name', 'Position', 'Department', 'Result', 'Score'],
        align: ['right', 'left', 'left', 'left', 'left', 'left', 'right'],
        rows: s.attendees.map((a, i) => [
          String(i + 1),
          a.employee.employeeNo,
          fullName(a.employee),
          a.employee.position ?? '',
          a.employee.department?.name ?? '',
          // Blank until the trainer records one — "Pending" on every line of
          // a sheet handed round to sign would read as a result.
          a.result === 'PENDING' ? '' : statusLabel(a.result),
          a.score == null ? '' : String(Number(a.score)),
        ]),
      },
    ];
    if (s.notes) sections.push({ kind: 'text', title: 'Notes', body: s.notes });

    // No approval routes a session, so the sheet prints the people who
    // acted, each dated: whoever scheduled it, when they did, and the
    // trainer, dated by the completion that is their sign-off ("Pending"
    // until then). A cancelled session will never be conducted, so no slot
    // waits on it; a session from before the scheduler was recorded names
    // nobody rather than a guess.
    const contacts = await prisma.user.findMany({
      where: { id: { in: [s.trainerId, ...(s.createdById ? [s.createdById] : [])] } },
      select: { id: true, email: true, phone: true, employee: { select: { mobile: true } } },
    });
    const contactOf = (id: string | null) => {
      const u = contacts.find((c) => c.id === id);
      return u ? { phone: contactPhone(u), email: u.email } : {};
    };
    const signatories: Signatory[] = [
      ...(s.createdBy ? [{ role: 'Scheduled by', name: s.createdBy.name, ...contactOf(s.createdById), at: s.createdAt }] : []),
      ...(s.status === 'CANCELLED'
        ? []
        : [{ role: 'Conducted by', name: s.trainer.name, ...contactOf(s.trainerId), at: s.status === 'COMPLETED' ? s.completedAt : undefined }]),
    ];
    const pdf = await renderDocument({
      title: 'Training Attendance Sheet',
      documentNumber: s.number,
      date: s.startsAt,
      reference: `${s.course.code} ${s.course.title}`,
      sections,
      signatories,
    });
    await audit(
      { entityType: 'training_session', entityId: s.id, action: 'EXPORTED', summary: `Printed ${s.number} attendance sheet` },
      req,
    );
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${s.number}.pdf"`);
    res.send(pdf);
  }),
);

// ── Create ──────────────────────────────────────────────────────────────────

const sessionSchema = z.object({
  courseId: z.string().min(1, 'Which course?'),
  trainerId: z.string().min(1).optional(),
  provider: z.string().trim().max(200).nullable().optional(),
  startsAt: z.string().min(1, 'When does it start?'),
  endsAt: z.string().min(1, 'When does it end?'),
  venue: z.string().trim().max(200).nullable().optional(),
  capacity: z.number().int().min(1).max(1000).nullable().optional(),
  notes: z.string().trim().max(5000).nullable().optional(),
  googleUrl: z.string().trim().max(2000).nullable().optional(),
  employeeIds: z.array(z.string().min(1)).max(500).optional(),
});

/**
 * A training session keeps a Meet link and nothing else of Google's. A pasted
 * Calendar event link carries no room, so it is refused with the fix.
 */
function meetLinkOf(raw: string | null | undefined): string | null {
  const link = parseGoogleLink(raw);
  if (!link.meetLink && link.calendarEventUrl) {
    throw badRequest('That is a Calendar event link — open the event and paste its Google Meet link instead');
  }
  return link.meetLink;
}

async function activeCourse(id: string) {
  const course = await prisma.course.findUnique({ where: { id }, select: { id: true, isActive: true, title: true } });
  if (!course) throw badRequest('That course does not exist');
  if (!course.isActive) throw badRequest(`${course.title} is inactive — reactivate it before scheduling`);
  return course;
}

sessionRoutes.post(
  '/',
  require_('ghr.training_sessions.create'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const body = parseBody(sessionSchema, req.body);
    await activeCourse(body.courseId);
    const trainerId = body.trainerId ?? me.id;
    if (trainerId !== me.id) await assertTrainer(trainerId);
    const slot = timeWindow(body.startsAt, body.endsAt, MAX_SESSION_HOURS);
    const meetLink = meetLinkOf(body.googleUrl);
    const people = await enrollableEmployees(body.employeeIds ?? []);
    if (body.capacity != null && people.length > body.capacity) {
      throw badRequest(`${people.length} enrolled but the room holds ${body.capacity}`);
    }

    const created = await prisma.$transaction(async (tx) => {
      const number = await nextNumber('training_session', tx);
      return tx.trainingSession.create({
        data: {
          number,
          courseId: body.courseId,
          trainerId,
          provider: body.provider || null,
          startsAt: slot.startsAt,
          endsAt: slot.endsAt,
          venue: body.venue || null,
          meetLink,
          capacity: body.capacity ?? null,
          notes: body.notes || null,
          createdById: me.id,
          attendees: { create: people.map((p) => ({ employeeId: p.id, enrolledById: me.id })) },
        },
        select: detailSelect,
      });
    });

    await audit(
      {
        entityType: 'training_session',
        entityId: created.id,
        action: 'CREATED',
        summary: `${created.number} ${created.course.title} — ${created.attendees.length} enrolled`,
        after: { courseId: created.courseId, trainerId, startsAt: created.startsAt, endsAt: created.endsAt },
      },
      req,
    );
    const when = whenText(created.startsAt, created.endsAt);
    const notices: NotifyInput[] = created.attendees
      .filter((a) => a.employee.userId && a.employee.userId !== me.id)
      .map((a) => ({
        userId: a.employee.userId!,
        type: 'training.enrolled',
        title: `Enrolled: ${created.course.title}`,
        body: `${created.number} · ${when}`,
        link: SESSION_LINK(created.id),
      }));
    if (trainerId !== me.id) {
      notices.push({
        userId: trainerId,
        type: 'training.assigned',
        title: `You are training: ${created.course.title}`,
        body: `${created.number} · ${when} · scheduled by ${me.name}`,
        link: SESSION_LINK(created.id),
      });
    }
    await notify(notices);
    res.status(201).json(await present(created, me));
  }),
);

// ── Edit ────────────────────────────────────────────────────────────────────

const patchSchema = sessionSchema.omit({ employeeIds: true }).partial();

/**
 * A time change bumps the .ics SEQUENCE and tells everyone enrolled; a new
 * trainer is told they have it. Pasting a Meet link is not a change anybody
 * needs telling about.
 */
sessionRoutes.patch(
  '/:id',
  requireAny('ghr.training_sessions.edit_own', 'ghr.training_sessions.edit_all'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const before = await loadVisible(req.params.id, me);
    assertCanEdit(me, before);
    const body = parseBody(patchSchema, req.body);

    const data: Prisma.TrainingSessionUncheckedUpdateInput = {};
    if (body.courseId !== undefined && body.courseId !== before.courseId) {
      await activeCourse(body.courseId);
      data.courseId = body.courseId;
    }
    let newTrainer: ResolvedUser | null = null;
    if (body.trainerId !== undefined && body.trainerId !== before.trainerId) {
      newTrainer = await assertTrainer(body.trainerId);
      data.trainerId = body.trainerId;
    }
    if (body.provider !== undefined) data.provider = body.provider || null;
    if (body.venue !== undefined) data.venue = body.venue || null;
    if (body.notes !== undefined) data.notes = body.notes || null;
    if (body.capacity !== undefined) {
      if (body.capacity != null && body.capacity < before.attendees.length) {
        throw badRequest(`${before.attendees.length} are already enrolled — the capacity cannot be lower`);
      }
      data.capacity = body.capacity ?? null;
    }
    if (body.googleUrl !== undefined) data.meetLink = meetLinkOf(body.googleUrl);

    let timeChanged = false;
    if (body.startsAt !== undefined || body.endsAt !== undefined) {
      const slot = timeWindow(body.startsAt ?? before.startsAt, body.endsAt ?? before.endsAt, MAX_SESSION_HOURS);
      timeChanged =
        slot.startsAt.getTime() !== before.startsAt.getTime() || slot.endsAt.getTime() !== before.endsAt.getTime();
      if (timeChanged) {
        data.startsAt = slot.startsAt;
        data.endsAt = slot.endsAt;
      }
    }
    if (timeChanged || data.courseId) data.icsSequence = { increment: 1 };

    if (!Object.keys(data).length) {
      res.json(await present(before, me));
      return;
    }
    const s = await prisma.trainingSession.update({ where: { id: before.id }, data, select: detailSelect });
    const changed = Object.keys(data).filter((k) => k !== 'icsSequence');
    await audit(
      {
        entityType: 'training_session',
        entityId: s.id,
        action: 'UPDATED',
        summary: `${s.number}: ${changed.join(', ')} changed`,
        before: { courseId: before.courseId, trainerId: before.trainerId, startsAt: before.startsAt, endsAt: before.endsAt, venue: before.venue },
        after: { courseId: s.courseId, trainerId: s.trainerId, startsAt: s.startsAt, endsAt: s.endsAt, venue: s.venue },
      },
      req,
    );
    const notices: NotifyInput[] = [];
    if (timeChanged || data.courseId) {
      for (const a of s.attendees) {
        if (!a.employee.userId || a.employee.userId === me.id) continue;
        notices.push({
          userId: a.employee.userId,
          type: 'training.rescheduled',
          title: `Changed: ${s.course.title}`,
          body: `${s.number} now ${whenText(s.startsAt, s.endsAt)}`,
          link: SESSION_LINK(s.id),
        });
      }
    }
    if (newTrainer && newTrainer.id !== me.id) {
      notices.push({
        userId: newTrainer.id,
        type: 'training.assigned',
        title: `You are training: ${s.course.title}`,
        body: `${s.number} · ${whenText(s.startsAt, s.endsAt)}`,
        link: SESSION_LINK(s.id),
      });
    }
    await notify(notices);
    res.json(await present(s, me));
  }),
);

// ── Attendees ───────────────────────────────────────────────────────────────

const addAttendeesSchema = z.object({ employeeIds: z.array(z.string().min(1)).min(1).max(500) });

sessionRoutes.post(
  '/:id/attendees',
  requireAny('ghr.training_sessions.edit_own', 'ghr.training_sessions.edit_all'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const before = await loadVisible(req.params.id, me);
    assertCanEdit(me, before);
    const body = parseBody(addAttendeesSchema, req.body);
    const people = await enrollableEmployees(body.employeeIds);
    const already = new Set(before.attendees.map((a) => a.employeeId));
    const fresh = people.filter((p) => !already.has(p.id));
    if (before.capacity != null && before.attendees.length + fresh.length > before.capacity) {
      throw conflict(
        `The session holds ${before.capacity}; ${before.attendees.length} are enrolled — room for ${Math.max(0, before.capacity - before.attendees.length)} more`,
      );
    }
    if (fresh.length) {
      await prisma.trainingAttendee.createMany({
        data: fresh.map((p) => ({ sessionId: before.id, employeeId: p.id, enrolledById: me.id })),
        skipDuplicates: true,
      });
      await audit(
        {
          entityType: 'training_session',
          entityId: before.id,
          action: 'UPDATED',
          summary: `${before.number}: ${fresh.length} enrolled`,
        },
        req,
      );
      await notify(
        fresh
          .filter((p) => p.userId && p.userId !== me.id)
          .map((p) => ({
            userId: p.userId!,
            type: 'training.enrolled' as const,
            title: `Enrolled: ${before.course.title}`,
            body: `${before.number} · ${whenText(before.startsAt, before.endsAt)}`,
            link: SESSION_LINK(before.id),
          })),
      );
    }
    res.json(await present(await loadVisible(before.id, me), me));
  }),
);

sessionRoutes.delete(
  '/:id/attendees/:employeeId',
  requireAny('ghr.training_sessions.edit_own', 'ghr.training_sessions.edit_all'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const before = await loadVisible(req.params.id, me);
    assertCanEdit(me, before);
    const gone = before.attendees.find((a) => a.employeeId === req.params.employeeId);
    if (!gone) throw notFound('That person is not on this session');
    await prisma.trainingAttendee.delete({ where: { id: gone.id } });
    await audit(
      {
        entityType: 'training_session',
        entityId: before.id,
        action: 'UPDATED',
        summary: `${before.number}: ${fullName(gone.employee)} removed`,
      },
      req,
    );
    if (gone.employee.userId && gone.employee.userId !== me.id) {
      await notify({
        userId: gone.employee.userId,
        type: 'training.cancelled',
        title: `Taken off: ${before.course.title}`,
        body: `${before.number} — you are no longer enrolled`,
        link: MY_PASSPORT_LINK,
      });
    }
    res.json(await present(await loadVisible(before.id, me), me));
  }),
);

/**
 * Self-enrolment from the calendar, when `academy.rules.allowSelfEnrolment`
 * is on. Recorded with `enrolledById = null`, which is what lets the same
 * person withdraw again — somebody HR put on a course asks the trainer.
 */
sessionRoutes.post(
  '/:id/enrol-me',
  requireAny('ghr.training_calendar.view_all', ...SESSION_VIEW),
  handler(async (req, res) => {
    const me = currentUser(req);
    const rules = await academySettings();
    if (!rules.allowSelfEnrolment) throw forbidden('Self-enrolment is switched off — ask HR or the trainer to enrol you');
    const s = await loadVisible(req.params.id, me);
    const emp = await myEmployee(me.id);
    if (!emp || !emp.isActive) throw forbidden('Your login is not linked to an active employee record');
    if (s.status !== 'SCHEDULED') throw conflict('This session is not open for enrolment');
    if (s.startsAt <= new Date()) throw conflict('This session has already started');
    if (s.attendees.some((a) => a.employeeId === emp.id)) throw conflict('You are already enrolled');
    if (s.capacity != null && s.attendees.length >= s.capacity) throw conflict('This session is full');
    await prisma.trainingAttendee.create({ data: { sessionId: s.id, employeeId: emp.id, enrolledById: null } });
    await audit(
      { entityType: 'training_session', entityId: s.id, action: 'UPDATED', summary: `${s.number}: ${me.name} self-enrolled` },
      req,
    );
    if (s.trainerId !== me.id) {
      await notify({
        userId: s.trainerId,
        type: 'training.enrolled',
        title: `${me.name} enrolled: ${s.course.title}`,
        body: s.number,
        link: SESSION_LINK(s.id),
      });
    }
    res.json(await present(await loadVisible(s.id, me), me));
  }),
);

sessionRoutes.delete(
  '/:id/enrol-me',
  requireAny('ghr.training_calendar.view_all', ...SESSION_VIEW),
  handler(async (req, res) => {
    const me = currentUser(req);
    const s = await loadVisible(req.params.id, me);
    const mine = s.attendees.find((a) => a.employee.userId === me.id);
    if (!mine) throw notFound('You are not enrolled on this session');
    if (mine.enrolledById !== null) throw forbidden('You were enrolled by HR or the trainer — ask them to take you off');
    if (s.status !== 'SCHEDULED' || s.startsAt <= new Date()) throw conflict('It is too late to withdraw from this session');
    await prisma.trainingAttendee.delete({ where: { id: mine.id } });
    await audit(
      { entityType: 'training_session', entityId: s.id, action: 'UPDATED', summary: `${s.number}: ${me.name} withdrew` },
      req,
    );
    res.json(await present(await loadVisible(s.id, me), me));
  }),
);

// ── Results and completion ──────────────────────────────────────────────────

const resultsSchema = z.object({
  results: z
    .array(
      z.object({
        employeeId: z.string().min(1),
        result: z.enum(ATTENDEE_RESULTS),
        score: z.number().min(0).max(100).nullable().optional(),
      }),
    )
    .max(500)
    .default([]),
});

/** Saves results as a draft — the trainer fills them in as the day goes. */
sessionRoutes.put(
  '/:id/results',
  requireAny('ghr.training_sessions.edit_own', 'ghr.training_sessions.edit_all'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const before = await loadVisible(req.params.id, me);
    assertCanEdit(me, before);
    const body = parseBody(resultsSchema, req.body);
    await prisma.$transaction((tx) => applyResults(tx, before.id, body.results));
    await audit(
      {
        entityType: 'training_session',
        entityId: before.id,
        action: 'UPDATED',
        summary: `${before.number}: ${body.results.length} result(s) recorded`,
      },
      req,
    );
    res.json(await present(await loadVisible(before.id, me), me));
  }),
);

/**
 * Final. Completion writes a VERIFIED passport record for everyone who
 * passed, dated the day the session ended, expiring by the course's
 * validity. There is no approval step and no reopening.
 */
sessionRoutes.post(
  '/:id/complete',
  requireAny('ghr.training_sessions.edit_own', 'ghr.training_sessions.edit_all'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const before = await loadVisible(req.params.id, me);
    assertCanEdit(me, before);
    const body = parseBody(resultsSchema, req.body ?? {});
    const outcome = await prisma.$transaction(async (tx) => {
      await applyResults(tx, before.id, body.results);
      const done = await completeSession(tx, before.id, me.id);
      await audit(
        {
          entityType: 'training_session',
          entityId: before.id,
          action: 'COMPLETED',
          summary: `${before.number}: ${done.passed} passed, ${done.failed} failed, ${done.noShow} no-show`,
        },
        req,
        tx,
      );
      return done;
    });
    const s = await loadVisible(before.id, me);
    await notify(
      s.attendees
        .filter((a) => a.employee.userId && a.result !== 'NO_SHOW')
        .map((a) => ({
          userId: a.employee.userId!,
          type: 'training.completed' as const,
          title: a.result === 'PASSED' ? `Passed: ${s.course.title}` : `Result: ${s.course.title}`,
          body:
            a.result === 'PASSED'
              ? `${s.number} — recorded in your training passport`
              : `${s.number} — not passed; the trainer can book you on the next session`,
          link: MY_PASSPORT_LINK,
        })),
    );
    res.json({ ...(await present(s, me)), outcome });
  }),
);

const cancelSchema = z.object({ reason: z.string().trim().min(3, 'Say why it is off').max(500) });

sessionRoutes.post(
  '/:id/cancel',
  requireAny('ghr.training_sessions.edit_own', 'ghr.training_sessions.edit_all'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const before = await loadVisible(req.params.id, me);
    assertCanEdit(me, before);
    const body = parseBody(cancelSchema, req.body);
    const s = await prisma.trainingSession.update({
      where: { id: before.id },
      data: { status: 'CANCELLED', cancelReason: body.reason, icsSequence: { increment: 1 } },
      select: detailSelect,
    });
    await audit(
      { entityType: 'training_session', entityId: s.id, action: 'CANCELLED', summary: `${s.number}: ${body.reason}` },
      req,
    );
    await notify(
      s.attendees
        .filter((a) => a.employee.userId && a.employee.userId !== me.id)
        .map((a) => ({
          userId: a.employee.userId!,
          type: 'training.cancelled' as const,
          title: `Cancelled: ${s.course.title}`,
          body: `${s.number} — ${body.reason}`,
          link: SESSION_LINK(s.id),
        })),
    );
    res.json(await present(s, me));
  }),
);

/** Only a session nobody is on can vanish; otherwise cancel it, so they are told. */
sessionRoutes.delete(
  '/:id',
  requireAny('ghr.training_sessions.delete', 'ghr.training_sessions.edit_own', 'ghr.training_sessions.edit_all'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const s = await loadVisible(req.params.id, me);
    if (!can(me, 'ghr.training_sessions.delete') && !canEditSession(me, s)) {
      throw forbidden('Only the trainer can delete this session');
    }
    if (s.status === 'COMPLETED' || s._count.records) throw conflict('A completed session is a record — it cannot be deleted');
    if (s.attendees.length) throw conflict('People are enrolled — cancel the session instead, so they are told');
    await prisma.trainingSession.delete({ where: { id: s.id } });
    await audit(
      { entityType: 'training_session', entityId: s.id, action: 'DELETED', summary: `${s.number} ${s.course.title}` },
      req,
    );
    res.status(204).end();
  }),
);

// ════════════════════════════════════════════════════════════════════
//  PASSPORTS
// ════════════════════════════════════════════════════════════════════

export const passportRoutes = Router();

// A certificate scan is the holder's, and HR's who verify it.
registerAttachmentGuard('training_record', async (user, id) => {
  if (can(user, 'ghr.passports.view_all') || can(user, 'ghr.passports.approve')) return true;
  const rec = await prisma.trainingRecord.findUnique({
    where: { id },
    select: { employee: { select: { userId: true } } },
  });
  return !!rec && rec.employee.userId === user.id;
});
passportRoutes.use(authenticate);

const TC_LINK = (employeeId: string) => PASSPORT_LINK(employeeId);

/** Pending approval request ids for records awaiting HR, keyed by record id. */
async function pendingApprovals(recordIds: string[]): Promise<Map<string, string>> {
  if (!recordIds.length) return new Map();
  const rows = await prisma.approvalRequest.findMany({
    where: { documentType: 'training_certification', documentId: { in: recordIds }, status: 'PENDING' },
    select: { id: true, documentId: true },
  });
  return new Map(rows.map((r) => [r.documentId, r.id]));
}

async function presentPassport(employeeId: string, viewer: ResolvedUser) {
  await sweepExpiryNotices().catch((err) => console.error('Training expiry sweep failed:', err));
  const p = await passportFor(employeeId);
  if (!p) throw notFound('Employee not found');
  const approvals = await pendingApprovals(p.records.filter((r) => r.status === 'PENDING_VERIFICATION').map((r) => r.id));
  const own = p.employee.userId === viewer.id;
  return {
    ...p,
    own,
    canAddOwn: own && can(viewer, 'ghr.passport.create'),
    canRecord: !own && can(viewer, 'ghr.passports.create'),
    canVerify: !own && can(viewer, 'ghr.passports.approve'),
    records: p.records.map((r) => ({
      ...r,
      approvalRequestId: approvals.get(r.id) ?? null,
      canDelete:
        r.source === 'EXTERNAL' &&
        ((own && r.status === 'REJECTED') ||
          (can(viewer, 'ghr.passports.delete') && r.status !== 'PENDING_VERIFICATION')),
      canEdit: r.source === 'EXTERNAL' && r.status !== 'PENDING_VERIFICATION' && can(viewer, 'ghr.passports.edit_all') && !own,
    })),
  };
}

/** The dashboard tile, and the Passports header — one figure, `teamReadiness()`. */
passportRoutes.get(
  '/summary',
  requireAny('ghr.passports.view_all', 'ghr.dashboard.view_all'),
  handler(async (_req, res) => {
    res.json(await teamReadiness());
  }),
);

/** The verification queue: external certificates waiting on HR. */
passportRoutes.get(
  '/records',
  require_('ghr.passports.view_all'),
  handler(async (req, res) => {
    const status = typeof req.query.status === 'string' ? req.query.status : 'PENDING_VERIFICATION';
    if (!['PENDING_VERIFICATION', 'VERIFIED', 'REJECTED'].includes(status)) throw badRequest('Unknown status');
    const rows = await prisma.trainingRecord.findMany({
      where: { status: status as 'PENDING_VERIFICATION' | 'VERIFIED' | 'REJECTED', source: 'EXTERNAL' },
      orderBy: { createdAt: 'asc' },
      take: 100,
      select: {
        id: true,
        number: true,
        status: true,
        completedAt: true,
        expiresAt: true,
        provider: true,
        certificateNo: true,
        createdAt: true,
        course: { select: { id: true, code: true, title: true } },
        employee: { select: { id: true, employeeNo: true, firstName: true, lastName: true, userId: true } },
      },
    });
    const approvals = await pendingApprovals(rows.map((r) => r.id));
    res.json(
      rows.map(({ employee, ...r }) => ({
        ...r,
        employee: { id: employee.id, employeeNo: employee.employeeNo, name: fullName(employee) },
        approvalRequestId: approvals.get(r.id) ?? null,
      })),
    );
  }),
);

passportRoutes.get(
  '/me',
  requireAny('ghr.passport.view_own', 'ghr.passports.view_all'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const emp = await myEmployee(me.id);
    if (!emp) throw notFound('Your login is not linked to an employee record — ask HR to link it');
    res.json(await presentPassport(emp.id, me));
  }),
);

/**
 * The passport register's rows — the screen's and the printed list's, from
 * one query. Readiness is derived, so the standing filter and the sort run
 * over the computed rows: a few hundred people at most, which is cheaper
 * than a second copy of the numbers. `?ids=` narrows to the rows ticked.
 */
async function passportRows(q: ListQuery) {
  const f = q.filters;
  const and: Prisma.EmployeeWhereInput[] = [];
  if (f.active !== 'all') and.push({ isActive: f.active === 'false' ? false : true });
  if (f.departmentId) and.push({ departmentId: f.departmentId === 'none' ? null : f.departmentId });
  if (f.positionId) and.push({ positionId: f.positionId === 'none' ? null : f.positionId });
  if (q.search) {
    and.push({
      OR: [
        { firstName: { contains: q.search, mode: 'insensitive' } },
        { lastName: { contains: q.search, mode: 'insensitive' } },
        { employeeNo: { contains: q.search, mode: 'insensitive' } },
        { position: { contains: q.search, mode: 'insensitive' } },
      ],
    });
  }
  const ids = idsFilter(f.ids);
  if (ids) and.push({ id: { in: ids } });
  const employees = await prisma.employee.findMany({
    where: { AND: and },
    select: {
      id: true,
      employeeNo: true,
      firstName: true,
      lastName: true,
      position: true,
      isActive: true,
      departmentId: true,
      positionId: true,
      department: { select: { id: true, name: true } },
    },
    orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }],
  });
  const readiness = await readinessFor(employees);
  let rows = employees.map((e) => {
    const r = readiness.get(e.id)!;
    return {
      id: e.id,
      employeeNo: e.employeeNo,
      name: `${e.lastName}, ${e.firstName}`,
      position: e.position,
      department: e.department,
      isActive: e.isActive,
      ...r,
    };
  });
  if (f.state === 'gaps') rows = rows.filter((r) => r.missing + r.expired > 0);
  else if (f.state === 'expiring') rows = rows.filter((r) => r.expiring > 0);
  else if (f.state === 'ready') rows = rows.filter((r) => r.required > 0 && r.held === r.required);
  else if (f.state === 'pending') rows = rows.filter((r) => r.pending > 0);
  else if (f.state === 'none') rows = rows.filter((r) => r.required === 0);

  const dir = q.dir === 'asc' ? 1 : -1;
  if (q.sort === 'pct') rows.sort((a, b) => ((a.pct ?? 101) - (b.pct ?? 101)) * dir);
  else if (q.sort === 'required') rows.sort((a, b) => (a.required - b.required) * dir);
  else if (q.sort === 'name') rows.sort((a, b) => a.name.localeCompare(b.name) * dir);
  else if (q.sort === 'employeeNo') rows.sort((a, b) => a.employeeNo.localeCompare(b.employeeNo) * dir);
  return rows;
}

/** The register: every employee with their readiness (`passportRows`). */
passportRoutes.get(
  '/',
  require_('ghr.passports.view_all'),
  handler(async (req, res) => {
    const q = listQuery(req);
    const rows = await passportRows(q);
    res.json(listResult(rows.slice((q.page - 1) * q.pageSize, q.page * q.pageSize), rows.length, q));
  }),
);

const STANDING_NAMED: Record<string, string> = {
  gaps: 'with gaps',
  expiring: 'something expiring',
  pending: 'awaiting HR',
  ready: 'fully ready',
  none: 'nothing required',
};

/**
 * The passport register on paper — the list as filtered (or the rows
 * ticked), through `passportRows`, so the paper is the screen it was printed
 * off: each person's readiness, what they hold of what is required, what is
 * expiring, the gaps and what waits on HR. Each person's courses one by one
 * are their own passport. Declared above `/:employeeId`, or that route
 * swallows it.
 */
passportRoutes.get(
  '/pdf',
  require_('ghr.passports.view_all'),
  handler(async (req, res) => {
    const q = listQuery(req);
    const f = q.filters;
    const all = await passportRows(q);
    const rows = all.slice(0, LIST_CAP);
    const [department, position] = await Promise.all([
      f.departmentId && f.departmentId !== 'none'
        ? prisma.department.findUnique({ where: { id: f.departmentId }, select: { name: true } })
        : null,
      f.positionId && f.positionId !== 'none'
        ? prisma.position.findUnique({ where: { id: f.positionId }, select: { title: true } })
        : null,
    ]);
    const reference = listReference(all.length, rows.length, ['person', 'people'], [
      q.search && `search "${q.search}"`,
      f.state && STANDING_NAMED[f.state],
      f.departmentId && (f.departmentId === 'none' ? 'no department' : `department ${department?.name ?? 'not found'}`),
      f.positionId && (f.positionId === 'none' ? 'no plantilla position' : `position ${position?.title ?? 'not found'}`),
      f.active === 'false' ? 'inactive employees' : f.active === 'all' ? 'active and inactive employees' : null,
      f.ids && 'the rows selected',
    ]);

    // Eight columns: landscape (rule 6).
    const pdf = await renderDocument({
      title: 'Training Passports',
      date: new Date(),
      reference,
      landscape: true,
      sections: [
        {
          kind: 'table',
          head: ['Number', 'Employee', 'Position', 'Readiness', 'Held', 'Expiring', 'Gaps', 'Awaiting HR'],
          align: ['left', 'left', 'left', 'right', 'right', 'right', 'right', 'right'],
          rows: rows.map((r) => [
            r.employeeNo,
            r.isActive ? r.name : { title: r.name, body: 'Inactive' },
            { title: r.position ?? 'Unclassified', body: r.department?.name ?? 'No department' },
            r.pct == null ? 'Nothing required' : `${r.pct}%`,
            r.required ? `${r.held} of ${r.required}` : '—',
            String(r.expiring),
            r.missing + r.expired
              ? { title: String(r.missing + r.expired), body: `${r.missing} missing, ${r.expired} expired` }
              : '0',
            String(r.pending),
          ]),
        },
      ],
    });
    await audit(
      { entityType: 'training_passport', entityId: 'list', action: 'EXPORTED', summary: `Exported the training passport register as PDF (${rows.length} person(s))` },
      req,
    );
    sendListPdf(res, pdf, 'training-passports.pdf');
  }),
);

passportRoutes.get(
  '/:employeeId',
  requireAny('ghr.passports.view_all', 'ghr.passport.view_own'),
  handler(async (req, res) => {
    const me = currentUser(req);
    if (!can(me, 'ghr.passports.view_all')) {
      const emp = await myEmployee(me.id);
      if (emp?.id !== req.params.employeeId) throw notFound('Employee not found');
    }
    res.json(await presentPassport(req.params.employeeId, me));
  }),
);

const externalSchema = z.object({
  courseId: z.string().min(1, 'Which course is the certificate for?'),
  completedAt: z.string().min(1, 'When was it completed?'),
  /** Blank = the course's validity from the completion date (or never). */
  expiresAt: z.string().nullable().optional(),
  provider: z.string().trim().min(2, 'Who issued it?').max(200),
  certificateNo: z.string().trim().max(100).nullable().optional(),
  notes: z.string().trim().max(2000).nullable().optional(),
});

async function externalData(body: z.infer<typeof externalSchema>) {
  const course = await prisma.course.findUnique({
    where: { id: body.courseId },
    select: { id: true, title: true, isActive: true, validityMonths: true },
  });
  if (!course || !course.isActive) throw badRequest('Choose an active course');
  const completedAt = manilaDate(asDate(body.completedAt, 'Completed')!);
  if (completedAt > manilaDate(new Date())) throw badRequest('A certificate cannot be completed in the future');
  const given = asDate(body.expiresAt, 'Expires');
  const expiresAt = given ? manilaDate(given) : expiryFor(completedAt, course.validityMonths);
  if (expiresAt && expiresAt <= completedAt) throw badRequest('It expires before it was completed');
  return { course, completedAt, expiresAt };
}

/**
 * An employee enters an external certificate; HR verifies it through the
 * approval engine. Numbered from `training_certification` inside the create
 * — and deleted again if the submission is refused, so no half-filed record
 * sits in the passport claiming to be on its way.
 */
passportRoutes.post(
  '/me/records',
  require_('ghr.passport.create'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const emp = await myEmployee(me.id);
    if (!emp || !emp.isActive) throw forbidden('Your login is not linked to an active employee record');
    const body = parseBody(externalSchema, req.body);
    const { course, completedAt, expiresAt } = await externalData(body);
    // Refuse before numbering, so a missing workflow does not burn a number.
    const workflow = await pickWorkflow('training_certification');
    if (!workflow || !workflow.steps.length) {
      throw badRequest('No approval workflow is configured for training certifications. Set one up in Admin › Approval Workflows.');
    }

    const record = await prisma.$transaction(async (tx) => {
      const number = await nextNumber('training_certification', tx);
      return tx.trainingRecord.create({
        data: {
          number,
          employeeId: emp.id,
          courseId: course.id,
          source: 'EXTERNAL',
          status: 'PENDING_VERIFICATION',
          completedAt,
          expiresAt,
          provider: body.provider,
          certificateNo: body.certificateNo || null,
          notes: body.notes || null,
          createdById: me.id,
        },
        select: { id: true, number: true },
      });
    });

    try {
      await submitForApproval({
        documentType: 'training_certification',
        documentId: record.id,
        documentNumber: record.number,
        subject: `${course.title} — ${fullName(emp)}`,
        link: TC_LINK(emp.id),
        requesterId: me.id,
      });
    } catch (err) {
      await prisma.trainingRecord.delete({ where: { id: record.id } });
      throw err;
    }
    await audit(
      {
        entityType: 'training_record',
        entityId: record.id,
        action: 'CREATED',
        summary: `${record.number} ${course.title} — external, for HR to verify`,
      },
      req,
    );
    res.status(201).json(await presentPassport(emp.id, me));
  }),
);

/**
 * HR records training directly — VERIFIED at once, by them. Never for
 * themselves: their own certificate goes through My Training Passport, so
 * somebody else verifies it (rule 3's intent, outside the engine).
 */
passportRoutes.post(
  '/:employeeId/records',
  require_('ghr.passports.create'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const emp = await prisma.employee.findUnique({
      where: { id: req.params.employeeId },
      select: { id: true, firstName: true, lastName: true, userId: true, isActive: true },
    });
    if (!emp) throw notFound('Employee not found');
    if (emp.userId === me.id) {
      throw forbidden('Enter your own certificate from My Training Passport, so another HR officer verifies it');
    }
    const body = parseBody(externalSchema, req.body);
    const { course, completedAt, expiresAt } = await externalData(body);
    const now = new Date();
    const record = await prisma.$transaction(async (tx) => {
      const number = await nextNumber('training_certification', tx);
      const rec = await tx.trainingRecord.create({
        data: {
          number,
          employeeId: emp.id,
          courseId: course.id,
          source: 'EXTERNAL',
          status: 'VERIFIED',
          completedAt,
          expiresAt,
          provider: body.provider,
          certificateNo: body.certificateNo || null,
          notes: body.notes || null,
          verifiedById: me.id,
          verifiedAt: now,
          createdById: me.id,
        },
        select: { id: true, number: true },
      });
      await audit(
        {
          entityType: 'training_record',
          entityId: rec.id,
          action: 'CREATED',
          summary: `${rec.number} ${course.title} for ${fullName(emp)} — recorded and verified by HR`,
        },
        req,
        tx,
      );
      return rec;
    });
    void record;
    res.status(201).json(await presentPassport(emp.id, me));
  }),
);

const recordPatchSchema = externalSchema.omit({ courseId: true }).partial();

/** HR corrects a verified or rejected external certificate. Session records are the session's. */
passportRoutes.patch(
  '/records/:id',
  require_('ghr.passports.edit_all'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const before = await prisma.trainingRecord.findUnique({
      where: { id: req.params.id },
      select: {
        id: true,
        number: true,
        employeeId: true,
        source: true,
        status: true,
        completedAt: true,
        expiresAt: true,
        provider: true,
        certificateNo: true,
        employee: { select: { userId: true } },
      },
    });
    if (!before) throw notFound('Training record not found');
    if (before.source !== 'EXTERNAL') throw conflict('A session record is the session’s result — it cannot be edited');
    if (before.status === 'PENDING_VERIFICATION') throw conflict('This certificate is waiting on HR — decide it first');
    if (before.employee.userId === me.id) throw forbidden('You cannot correct your own training record');
    const body = parseBody(recordPatchSchema, req.body);
    const data: Prisma.TrainingRecordUpdateInput = {};
    const completedAt = body.completedAt ? manilaDate(asDate(body.completedAt, 'Completed')!) : before.completedAt;
    if (body.completedAt) data.completedAt = completedAt;
    if (body.expiresAt !== undefined) {
      const exp = body.expiresAt ? manilaDate(asDate(body.expiresAt, 'Expires')!) : null;
      if (exp && exp <= completedAt) throw badRequest('It expires before it was completed');
      data.expiresAt = exp;
      // A new date earns its own notice.
      data.expiryNoticeAt = null;
    }
    if (body.provider !== undefined) data.provider = body.provider;
    if (body.certificateNo !== undefined) data.certificateNo = body.certificateNo || null;
    if (body.notes !== undefined) data.notes = body.notes || null;
    const after = await prisma.trainingRecord.update({
      where: { id: before.id },
      data,
      select: { completedAt: true, expiresAt: true, provider: true, certificateNo: true },
    });
    await audit(
      {
        entityType: 'training_record',
        entityId: before.id,
        action: 'UPDATED',
        summary: `${before.number ?? 'Training record'} corrected`,
        before: {
          completedAt: before.completedAt,
          expiresAt: before.expiresAt,
          provider: before.provider,
          certificateNo: before.certificateNo,
        },
        after,
      },
      req,
    );
    res.json(await presentPassport(before.employeeId, me));
  }),
);

passportRoutes.delete(
  '/records/:id',
  requireAny('ghr.passports.delete', 'ghr.passport.create'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const rec = await prisma.trainingRecord.findUnique({
      where: { id: req.params.id },
      select: { id: true, number: true, employeeId: true, source: true, status: true, employee: { select: { userId: true } } },
    });
    if (!rec) throw notFound('Training record not found');
    if (rec.source !== 'EXTERNAL') throw conflict('A session record is the session’s result — it cannot be deleted');
    if (rec.status === 'PENDING_VERIFICATION') throw conflict('This certificate is waiting on HR — it can be removed once decided');
    const own = rec.employee.userId === me.id;
    const allowed = (own && rec.status === 'REJECTED') || (!own && can(me, 'ghr.passports.delete'));
    if (!allowed) throw forbidden('You cannot remove this record');
    await prisma.trainingRecord.delete({ where: { id: rec.id } });
    await audit(
      { entityType: 'training_record', entityId: rec.id, action: 'DELETED', summary: `${rec.number ?? 'Training record'} removed` },
      req,
    );
    res.status(204).end();
  }),
);

/**
 * HR's decision. Approved → VERIFIED, by whoever approved the last step;
 * rejected (or returned) → REJECTED, and it counts for nothing.
 */
onApprovalSettled('training_certification', async (request, outcome) => {
  if (outcome === 'APPROVED') {
    const last = await prisma.approvalAction.findFirst({
      where: { requestId: request.id, action: 'APPROVED' },
      orderBy: { actedAt: 'desc' },
      select: { approverId: true, actedAt: true },
    });
    await prisma.trainingRecord.updateMany({
      where: { id: request.documentId, status: 'PENDING_VERIFICATION' },
      data: { status: 'VERIFIED', verifiedById: last?.approverId ?? null, verifiedAt: last?.actedAt ?? new Date() },
    });
  } else {
    await prisma.trainingRecord.updateMany({
      where: { id: request.documentId, status: 'PENDING_VERIFICATION' },
      data: { status: 'REJECTED' },
    });
  }
});

// ════════════════════════════════════════════════════════════════════
//  SETTINGS
// ════════════════════════════════════════════════════════════════════

export const academySettingsRoutes = Router();
academySettingsRoutes.use(authenticate);

/** Read by the course form (categories) and the calendar (self-enrolment). Nothing secret. */
academySettingsRoutes.get(
  '/',
  handler(async (_req, res) => {
    res.json(await academySettings());
  }),
);

academySettingsRoutes.put(
  '/',
  require_('ghr.settings.edit_all'),
  handler(async (req, res) => {
    const body = parseBody(
      z.object({
        expiryWarningDays: z.number().int().min(0).max(365).optional(),
        allowSelfEnrolment: z.boolean().optional(),
        categories: z.array(z.string().trim().min(1).max(60)).max(30).optional(),
      }),
      req.body,
    );
    if (body.categories) {
      const seen = new Set<string>();
      for (const c of body.categories) {
        const k = c.toLowerCase();
        if (seen.has(k)) throw badRequest(`"${c}" is listed twice`);
        seen.add(k);
      }
    }
    const before = await academySettings();
    const saved = await saveAcademySettings(body);
    await audit(
      {
        entityType: 'setting',
        entityId: 'academy.rules',
        action: 'UPDATED',
        summary: 'Updated Academy rules',
        before,
        after: saved,
      },
      req,
    );
    res.json(saved);
  }),
);

// ════════════════════════════════════════════════════════════════════
//  SEARCH AND TODAY'S SCHEDULE
// ════════════════════════════════════════════════════════════════════

registerSearch({
  kind: 'course',
  label: 'Courses',
  permission: 'ghr.courses.view_all',
  search: async (term, _user, limit) => {
    const rows = await prisma.course.findMany({
      where: {
        OR: [
          { code: { contains: term, mode: 'insensitive' } },
          { title: { contains: term, mode: 'insensitive' } },
          { category: { contains: term, mode: 'insensitive' } },
        ],
      },
      orderBy: { code: 'asc' },
      take: limit,
      select: { id: true, code: true, title: true, category: true, isActive: true },
    });
    return rows.map((c) => ({
      kind: 'course',
      id: c.id,
      title: c.title,
      subtitle: [c.code, c.category, c.isActive ? null : 'inactive'].filter(Boolean).join(' · '),
      link: `/g-hr/academy/courses?course=${c.id}`,
    }));
  },
});

registerSearch({
  kind: 'training_session',
  label: 'Training',
  permission: ['ghr.training_sessions.view_all', 'ghr.training_sessions.view_own'],
  ownWhere: (user) => participantWhere(user.id) as Record<string, unknown>,
  search: async (term, _user, limit, own) => {
    const rows = await prisma.trainingSession.findMany({
      where: {
        AND: [
          (own ?? {}) as Prisma.TrainingSessionWhereInput,
          {
            OR: [
              { number: { contains: term, mode: 'insensitive' } },
              { venue: { contains: term, mode: 'insensitive' } },
              { course: { title: { contains: term, mode: 'insensitive' } } },
              { course: { code: { contains: term, mode: 'insensitive' } } },
            ],
          },
        ],
      },
      orderBy: { startsAt: 'desc' },
      take: limit,
      select: { id: true, number: true, startsAt: true, status: true, course: { select: { title: true } } },
    });
    return rows.map((s) => ({
      kind: 'training_session',
      id: s.id,
      title: s.course.title,
      subtitle: [s.number, dateTimeFmt.format(s.startsAt), s.status === 'SCHEDULED' ? null : s.status.toLowerCase()]
        .filter(Boolean)
        .join(' · '),
      link: SESSION_LINK(s.id),
    }));
  },
});

/**
 * Today's SCHEDULED sessions I train or am enrolled on. Somebody marked a
 * no-show in advance is not expected, so they are left off the day.
 */
registerSchedule(async (user, { from, to }) => {
  const rows = await prisma.trainingSession.findMany({
    where: {
      status: 'SCHEDULED',
      startsAt: { gte: from, lt: to },
      OR: [
        { trainerId: user.id },
        { attendees: { some: { employee: { userId: user.id }, result: { not: 'NO_SHOW' } } } },
      ],
    },
    orderBy: { startsAt: 'asc' },
    select: {
      id: true,
      startsAt: true,
      endsAt: true,
      venue: true,
      meetLink: true,
      trainerId: true,
      trainer: { select: { name: true } },
      course: { select: { title: true } },
    },
  });
  return rows.map((s) => ({
    kind: 'training',
    id: s.id,
    title: `Training: ${s.course.title}`,
    startsAt: s.startsAt,
    endsAt: s.endsAt,
    link: SESSION_LINK(s.id),
    meetLink: s.meetLink,
    sub: s.trainerId === user.id ? `You train${s.venue ? ` · ${s.venue}` : ''}` : `${s.trainer.name}${s.venue ? ` · ${s.venue}` : ''}`,
  }));
});
