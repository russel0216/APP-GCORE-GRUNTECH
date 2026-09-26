import fs from 'node:fs';
import { Router, type Request } from 'express';
import { z } from 'zod';
import { Prisma, AttendanceStatus, LeaveStatus, OtStage } from '@prisma/client';
import { prisma } from '../prisma';
import {
  handler,
  parseBody,
  listQuery,
  listResult,
  orderBy,
  notFound,
  badRequest,
  forbidden,
} from '../http/kit';
import { authenticate, require_, requireAny, currentUser } from '../auth/middleware';
import { audit } from '../shared/audit';
import { nextNumber } from '../shared/numbering';
import { notify } from '../shared/notifications';
import { submitForApproval, onApprovalSettled } from '../shared/approvals';
import { postJobCost } from '../shared/inventory';
import { upload, saveAttachment, attachmentPath, deleteAttachment } from '../shared/attachments';
import { describeFace, faceEngineReady } from '../shared/face';
import { toCsv } from '../shared/csv';
import {
  hrSettings,
  saveHrSettings,
  settingList,
  myEmployee,
  attendanceDay,
  matchFace,
  classifyArrival,
  workedMinutes,
  overtimeHours,
  overtimeRate,
  leaveDays,
  leaveBalance,
  ensureBalance,
  dayKey,
  toMinutes,
} from '../shared/hr';

const D = (v: number | string | null | undefined) =>
  v === null || v === undefined ? new Prisma.Decimal(0) : new Prisma.Decimal(v);
const num = (v: Prisma.Decimal | null | undefined) => (v == null ? 0 : Number(v));
const cents = (n: number) => Math.round(n * 100) / 100;

function asDate(v: string | null | undefined): Date | null {
  if (!v) return null;
  const date = new Date(v);
  if (Number.isNaN(date.getTime())) throw badRequest(`"${v}" is not a valid date`);
  return date;
}

/** A filter value from the URL, accepted only if it names a real enum member. */
function asEnum<T extends Record<string, string>>(e: T, value: string | undefined): T[keyof T] | undefined {
  return value && value in e ? (value as T[keyof T]) : undefined;
}

// ════════════════════════════════════════════════════════════════════
//  CLOCK IN / OUT
// ════════════════════════════════════════════════════════════════════

export const clockRoutes = Router();
clockRoutes.use(authenticate);

/**
 * Where today's attendance stands for the signed-in person.
 *
 * "Any one who access the web application can clock in clock out" — so this is
 * deliberately available to every authenticated user, not gated behind an HR
 * permission.
 */
clockRoutes.get(
  '/me',
  handler(async (req, res) => {
    const me = currentUser(req);
    const employee = await myEmployee(me.id);
    const settings = await hrSettings();

    if (!employee) {
      res.json({
        employee: null,
        message:
          'Your user account is not linked to an employee record, so attendance cannot be recorded. Ask HR to link it.',
        settings,
      });
      return;
    }

    const today = dayKey(new Date());
    const [attendance, faces] = await Promise.all([
      prisma.attendance.findUnique({
        where: { employeeId_date: { employeeId: employee.id, date: today } },
      }),
      prisma.faceEnrollment.count({ where: { employeeId: employee.id } }),
    ]);

    res.json({
      employee,
      enrolled: faces > 0,
      faceSamples: faces,
      faceEngineReady: faceEngineReady(),
      today: attendance
        ? {
            ...attendance,
            timeInScore: attendance.timeInScore ? num(attendance.timeInScore) : null,
            timeOutScore: attendance.timeOutScore ? num(attendance.timeOutScore) : null,
          }
        : null,
      settings,
    });
  }),
);

/**
 * The camera frame, as it arrived.
 *
 * Multer has already written it to the upload directory; the bytes are read
 * back for the detector. The browser sends a picture and nothing else — the
 * descriptor is computed here, on the server, so the client never gets to
 * assert whose face it is (see src/shared/face.ts).
 */
function capturedPhoto(req: Request): Buffer {
  if (!req.file) throw badRequest('No photo was captured — allow the camera and try again');
  return fs.readFileSync(attachmentPath(req.file.filename));
}

clockRoutes.post(
  '/enroll',
  upload.single('photo'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const body = parseBody(
      z.object({
        employeeId: z.string().optional(),
        label: z.string().optional(),
      }),
      req.body,
    );

    const { descriptor, score } = await describeFace(capturedPhoto(req));
    const mine = await myEmployee(me.id);

    // Enrolling someone else needs the employee permission; enrolling yourself
    // does not — people set up their own face.
    let employeeId: string;
    if (body.employeeId && body.employeeId !== mine?.id) {
      if (!me.isSuperAdmin && !me.permissions.has('ghr.employees.edit_all')) {
        throw forbidden('You can only enrol your own face');
      }
      employeeId = body.employeeId;
    } else {
      if (!mine) throw badRequest('Your account is not linked to an employee record');
      employeeId = mine.id;
    }

    // A face already enrolled to someone ELSE means this capture would make
    // clock-in ambiguous. Refuse rather than quietly create a collision.
    const { best, threshold } = await matchFace(descriptor);
    if (best && best.employeeId !== employeeId && best.distance < threshold) {
      throw badRequest(
        `That face already matches ${best.name}. Enrolling it again would make clock-in ambiguous.`,
      );
    }

    // The enrolment photo is kept so HR can see whose face a sample actually
    // is, rather than only a row of 128 numbers.
    const attachment = await saveAttachment({
      entityType: 'face_enrollment',
      entityId: employeeId,
      file: req.file!,
      uploadedById: me.id,
      caption: `Face enrolment (detector confidence ${score})`,
    });

    const enrollment = await prisma.faceEnrollment.create({
      data: {
        employeeId,
        descriptor: descriptor as unknown as Prisma.InputJsonValue,
        photoPath: attachment.id,
        label: body.label || null,
        enrolledById: me.id,
      },
    });

    const count = await prisma.faceEnrollment.count({ where: { employeeId } });
    await audit(
      {
        entityType: 'employee',
        entityId: employeeId,
        action: 'UPDATED',
        summary: `Face enrolled (${count} sample${count === 1 ? '' : 's'})`,
      },
      req,
    );

    // A live enrolment capture is a BETTER account photo than anything a
    // plain upload could offer — it is verified, current and, per the note in
    // describeFace, provably one person. Whoever the enrolment was for (self
    // or, with the employee permission, someone else) gets it as their
    // picture too, replacing whichever the account had before. This is the
    // only path that touches User.photoPath from a face capture; nothing
    // enrols FROM a profile photo, only the other way round.
    const enrolledUser = await prisma.employee.findUnique({
      where: { id: employeeId },
      select: { userId: true },
    });
    if (enrolledUser?.userId) {
      const previous = await prisma.user.findUnique({
        where: { id: enrolledUser.userId },
        select: { photoPath: true },
      });
      await prisma.user.update({
        where: { id: enrolledUser.userId },
        data: { photoPath: attachment.id },
      });
      if (previous?.photoPath && previous.photoPath !== attachment.id) {
        await deleteAttachment(previous.photoPath).catch(() => {});
      }
    }

    res.status(201).json({ id: enrollment.id, samples: count });
  }),
);

clockRoutes.delete(
  '/enroll/:id',
  handler(async (req, res) => {
    const me = currentUser(req);
    const row = await prisma.faceEnrollment.findUnique({ where: { id: req.params.id } });
    if (!row) throw notFound('Enrolment not found');

    const mine = await myEmployee(me.id);
    if (row.employeeId !== mine?.id && !me.isSuperAdmin && !me.permissions.has('ghr.employees.edit_all')) {
      throw forbidden('That enrolment belongs to someone else');
    }
    await prisma.faceEnrollment.delete({ where: { id: row.id } });
    res.json({ ok: true });
  }),
);

/**
 * Clocking in or out.
 *
 * Face recognition is the normal path; a PIN or the biometric device is the
 * fallback when it fails. Whichever was used is recorded, along with the match
 * distance and the capture photo, so a questionable entry can be reviewed
 * rather than merely trusted.
 *
 * A fallback always demands a written reason. That is not bureaucracy: the
 * fallback is the weak door, and an unexplained one is the only thing an
 * audit would have to go on.
 */
const clockSchema = z.object({
  action: z.enum(['IN', 'OUT']),
  method: z.enum(['FACE', 'PIN', 'BIOMETRIC']).default('FACE'),
  fallbackReason: z.string().optional(),
});

clockRoutes.post(
  '/',
  upload.single('photo'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const body = parseBody(clockSchema, req.body);
    const settings = await hrSettings();

    const mine = await myEmployee(me.id);
    if (!mine) throw badRequest('Your account is not linked to an employee record');
    if (!mine.isActive) throw badRequest('That employee record is inactive');

    let matchedScore: number | null = null;

    if (body.method === 'FACE') {
      const { descriptor } = await describeFace(capturedPhoto(req));
      const { best, runnerUp, threshold } = await matchFace(descriptor);

      if (!best || best.distance > threshold) {
        throw badRequest(
          'Face not recognised. Try again in better light, or use the fallback if it keeps failing.',
        );
      }
      if (best.employeeId !== mine.id) {
        throw badRequest(
          `That face matches ${best.name}, not you. Each person clocks in on their own account.`,
        );
      }
      // Two people nearly as close means the match is not trustworthy, even
      // though the closest one passed.
      if (runnerUp && runnerUp.distance - best.distance < 0.05) {
        throw badRequest(
          'That face matches two people almost equally. Use the fallback and ask HR to re-enrol.',
        );
      }
      matchedScore = Math.round(best.distance * 10000) / 10000;
    } else if (!body.fallbackReason) {
      throw badRequest('Say why face recognition was not used — it is recorded against the entry');
    }

    // Always kept, on every method: the photo is the evidence, the match is
    // only the convenience. A fallback entry with a photo can still be checked.
    let photoId: string | null = null;
    if (req.file) {
      const attachment = await saveAttachment({
        entityType: 'attendance',
        entityId: mine.id,
        file: req.file,
        uploadedById: me.id,
        caption: `Clock ${body.action}`,
        capturedAt: new Date(),
      });
      photoId = attachment.id;
    }

    const now = new Date();
    const today = dayKey(now);
    const existing = await prisma.attendance.findUnique({
      where: { employeeId_date: { employeeId: mine.id, date: today } },
    });

    if (body.action === 'IN') {
      if (existing?.timeIn) {
        throw badRequest(`You already clocked in at ${existing.timeIn.toLocaleTimeString('en-PH')}`);
      }
      const arrival = classifyArrival(now, settings);
      const row = await prisma.attendance.upsert({
        where: { employeeId_date: { employeeId: mine.id, date: today } },
        create: {
          employeeId: mine.id,
          date: today,
          timeIn: now,
          timeInMethod: body.method,
          timeInPhoto: photoId,
          timeInScore: matchedScore != null ? D(matchedScore) : null,
          status: arrival.status,
          lateMinutes: arrival.lateMinutes,
          notes: body.fallbackReason || null,
        },
        update: {
          timeIn: now,
          timeInMethod: body.method,
          timeInPhoto: photoId,
          timeInScore: matchedScore != null ? D(matchedScore) : null,
          status: arrival.status,
          lateMinutes: arrival.lateMinutes,
        },
      });

      res.json({
        ok: true,
        action: 'IN',
        at: now,
        status: row.status,
        lateMinutes: row.lateMinutes,
        message:
          row.lateMinutes > 0
            ? `Clocked in at ${now.toLocaleTimeString('en-PH')} — ${row.lateMinutes} minutes late`
            : `Clocked in at ${now.toLocaleTimeString('en-PH')}`,
      });
      return;
    }

    if (!existing?.timeIn) throw badRequest('You have not clocked in today');
    if (existing.timeOut) {
      throw badRequest(`You already clocked out at ${existing.timeOut.toLocaleTimeString('en-PH')}`);
    }

    const worked = workedMinutes(existing.timeIn, now, settings);
    const row = await prisma.attendance.update({
      where: { id: existing.id },
      data: {
        timeOut: now,
        timeOutMethod: body.method,
        timeOutPhoto: photoId,
        timeOutScore: matchedScore != null ? D(matchedScore) : null,
        workedMinutes: worked,
      },
    });

    res.json({
      ok: true,
      action: 'OUT',
      at: now,
      workedMinutes: row.workedMinutes,
      message: `Clocked out at ${now.toLocaleTimeString('en-PH')} — ${(worked / 60).toFixed(2)} hours worked`,
    });
  }),
);

// ════════════════════════════════════════════════════════════════════
//  ATTENDANCE & DASHBOARD
// ════════════════════════════════════════════════════════════════════

export const attendanceRoutes = Router();
attendanceRoutes.use(authenticate);

attendanceRoutes.get(
  '/',
  require_('ghr.dashboard.view_all'),
  handler(async (req, res) => {
    const q = listQuery(req);
    const where: Prisma.AttendanceWhereInput = {};

    if (q.filters.from || q.filters.to) {
      where.date = {};
      if (q.filters.from) where.date.gte = new Date(q.filters.from);
      if (q.filters.to) where.date.lte = new Date(q.filters.to);
    } else if (q.filters.date) {
      where.date = new Date(q.filters.date);
    }
    const status = asEnum(AttendanceStatus, q.filters.status);
    if (status) where.status = status;
    if (q.filters.employeeId) where.employeeId = q.filters.employeeId;
    if (q.search) {
      where.employee = {
        OR: [
          { firstName: { contains: q.search, mode: 'insensitive' } },
          { lastName: { contains: q.search, mode: 'insensitive' } },
          { employeeNo: { contains: q.search, mode: 'insensitive' } },
        ],
      };
    }

    const [rows, total] = await Promise.all([
      prisma.attendance.findMany({
        where,
        include: {
          employee: {
            select: {
              id: true,
              employeeNo: true,
              firstName: true,
              lastName: true,
              position: true,
              department: { select: { name: true } },
            },
          },
        },
        orderBy: orderBy(q, ['date', 'timeIn'], { date: 'desc' }),
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
      }),
      prisma.attendance.count({ where }),
    ]);

    res.json(
      listResult(
        rows.map((r) => ({
          ...r,
          timeInScore: r.timeInScore ? num(r.timeInScore) : null,
          timeOutScore: r.timeOutScore ? num(r.timeOutScore) : null,
          workedHours: Math.round((r.workedMinutes / 60) * 100) / 100,
        })),
        total,
        q,
      ),
    );
  }),
);

/**
 * The HR dashboard for one day: present, late, on leave, absent, pending.
 *
 * The figures are `attendanceDay()` in shared/hr.ts, unchanged — the Insights
 * brief prints the same counts and must agree with this screen to the person.
 */
attendanceRoutes.get(
  '/dashboard',
  require_('ghr.dashboard.view_all'),
  handler(async (req, res) => {
    const date = req.query.date ? new Date(String(req.query.date)) : new Date();
    res.json(await attendanceDay(date));
  }),
);

/** CSV over a date range — "Menu to Extract CSV file selecting range of date." */
attendanceRoutes.get(
  '/export',
  require_('ghr.dashboard.export'),
  handler(async (req, res) => {
    const from = new Date(String(req.query.from ?? new Date().toISOString().slice(0, 10)));
    const to = new Date(String(req.query.to ?? from.toISOString().slice(0, 10)));

    const rows = await prisma.attendance.findMany({
      where: { date: { gte: dayKey(from), lte: dayKey(to) } },
      include: {
        employee: {
          select: {
            employeeNo: true,
            firstName: true,
            lastName: true,
            position: true,
            department: { select: { name: true } },
          },
        },
      },
      orderBy: [{ date: 'asc' }, { employee: { lastName: 'asc' } }],
    });

    const time = (d: Date | null) =>
      d ? d.toLocaleTimeString('en-PH', { hour12: false, hour: '2-digit', minute: '2-digit' }) : '';

    const header = [
      'Date',
      'Employee No',
      'Last Name',
      'First Name',
      'Department',
      'Position',
      'Time In',
      'Time Out',
      'Status',
      'Late (min)',
      'Worked (hrs)',
      'Method',
      'Notes',
    ];

    const lines = rows.map((r) => [
      r.date.toISOString().slice(0, 10),
      r.employee.employeeNo,
      r.employee.lastName,
      r.employee.firstName,
      r.employee.department?.name ?? '',
      r.employee.position ?? '',
      time(r.timeIn),
      time(r.timeOut),
      r.status,
      String(r.lateMinutes),
      (r.workedMinutes / 60).toFixed(2),
      r.timeInMethod ?? '',
      r.notes ?? '',
    ]);

    const csv = toCsv([header, ...lines]);

    await audit(
      {
        entityType: 'attendance',
        entityId: 'export',
        action: 'EXPORTED',
        summary: `Attendance ${from.toISOString().slice(0, 10)} to ${to.toISOString().slice(0, 10)} (${rows.length} rows)`,
      },
      req,
    );

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="attendance-${from.toISOString().slice(0, 10)}-to-${to.toISOString().slice(0, 10)}.csv"`,
    );
    res.send(`﻿${csv}`);
  }),
);

/** A manual correction — recorded as MANUAL, with who did it. */
attendanceRoutes.patch(
  '/:id',
  require_('ghr.dashboard.view_all'),
  handler(async (req, res) => {
    const me = currentUser(req);
    if (!me.isSuperAdmin && !me.permissions.has('ghr.employees.edit_all')) {
      throw forbidden('Correcting attendance needs the employee edit permission');
    }
    const body = parseBody(
      z.object({
        timeIn: z.string().optional().nullable(),
        timeOut: z.string().optional().nullable(),
        status: z.enum(['PRESENT', 'LATE', 'ABSENT', 'ON_LEAVE', 'HALF_DAY', 'REST_DAY']).optional(),
        notes: z.string().optional().nullable(),
      }),
      req.body,
    );

    const existing = await prisma.attendance.findUnique({ where: { id: req.params.id } });
    if (!existing) throw notFound('Attendance record not found');

    const settings = await hrSettings();
    const timeIn = body.timeIn !== undefined ? asDate(body.timeIn) : existing.timeIn;
    const timeOut = body.timeOut !== undefined ? asDate(body.timeOut) : existing.timeOut;

    const row = await prisma.attendance.update({
      where: { id: existing.id },
      data: {
        timeIn,
        timeOut,
        ...(body.notes !== undefined ? { notes: body.notes || null } : {}),
        // Re-derive lateness from the corrected time in, then let an explicit
        // status win — an approved excuse overrules the clock.
        ...(timeIn ? classifyArrival(timeIn, settings) : {}),
        ...(body.status ? { status: body.status } : {}),
        workedMinutes: timeIn && timeOut ? workedMinutes(timeIn, timeOut, settings) : 0,
        timeInMethod: body.timeIn !== undefined ? 'MANUAL' : existing.timeInMethod,
        timeOutMethod: body.timeOut !== undefined ? 'MANUAL' : existing.timeOutMethod,
        recordedById: me.id,
      },
    });

    await audit(
      {
        entityType: 'attendance',
        entityId: row.id,
        action: 'UPDATED',
        summary: `Attendance corrected manually for ${row.date.toISOString().slice(0, 10)}`,
        before: existing,
        after: row,
      },
      req,
    );
    res.json(row);
  }),
);

// ════════════════════════════════════════════════════════════════════
//  LEAVE
// ════════════════════════════════════════════════════════════════════

export const leaveRoutes = Router();
leaveRoutes.use(authenticate);

leaveRoutes.get(
  '/types',
  handler(async (_req, res) => {
    const types = await prisma.leaveType.findMany({ orderBy: { sortOrder: 'asc' } });
    res.json(types.map((t) => ({ ...t, daysPerYear: num(t.daysPerYear) })));
  }),
);

const leaveTypeSchema = z.object({
  code: z.string().trim().min(1).max(20),
  name: z.string().trim().min(2),
  daysPerYear: z.number().min(0).max(365),
  isPaid: z.boolean().default(true),
  requiresProof: z.boolean().default(false),
  sortOrder: z.number().int().default(0),
  isActive: z.boolean().default(true),
});

leaveRoutes.post(
  '/types',
  require_('ghr.settings.edit_all'),
  handler(async (req, res) => {
    const body = parseBody(leaveTypeSchema, req.body);
    const created = await prisma.leaveType.create({ data: { ...body, daysPerYear: D(body.daysPerYear) } });
    res.status(201).json({ ...created, daysPerYear: num(created.daysPerYear) });
  }),
);

leaveRoutes.patch(
  '/types/:id',
  require_('ghr.settings.edit_all'),
  handler(async (req, res) => {
    const body = parseBody(leaveTypeSchema.partial(), req.body);
    const updated = await prisma.leaveType.update({
      where: { id: req.params.id },
      data: {
        ...body,
        ...(body.daysPerYear !== undefined ? { daysPerYear: D(body.daysPerYear) } : {}),
      },
    });
    res.json({ ...updated, daysPerYear: num(updated.daysPerYear) });
  }),
);

/** My balances for the year, plus what is pending. */
leaveRoutes.get(
  '/balances',
  handler(async (req, res) => {
    const me = currentUser(req);
    const year = Number(req.query.year ?? new Date().getFullYear());
    const employeeId = req.query.employeeId ? String(req.query.employeeId) : null;

    let targetId = employeeId;
    if (!targetId) {
      const mine = await myEmployee(me.id);
      if (!mine) {
        res.json({ employee: null, balances: [] });
        return;
      }
      targetId = mine.id;
    } else if (!me.isSuperAdmin && !me.permissions.has('ghr.leave.view_all')) {
      const mine = await myEmployee(me.id);
      if (mine?.id !== targetId) throw forbidden('That is someone else’s leave balance');
    }

    const types = await prisma.leaveType.findMany({
      where: { isActive: true },
      orderBy: { sortOrder: 'asc' },
    });

    const balances = [];
    for (const type of types) {
      balances.push({
        leaveType: { id: type.id, code: type.code, name: type.name, isPaid: type.isPaid },
        year,
        ...(await leaveBalance(targetId, type.id, year)),
      });
    }

    res.json({ employeeId: targetId, year, balances });
  }),
);

leaveRoutes.get(
  '/',
  requireAny('ghr.leave.view_all', 'ghr.leave.view_own'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const q = listQuery(req);
    const where: Prisma.LeaveRequestWhereInput = {};

    const onlyOwn = !me.isSuperAdmin && !me.permissions.has('ghr.leave.view_all');
    if (onlyOwn || q.scope === 'mine') {
      const mine = await myEmployee(me.id);
      where.employeeId = mine?.id ?? '__none__';
    }
    const status = asEnum(LeaveStatus, q.filters.status);
    if (status) where.status = status;
    if (q.filters.employeeId) where.employeeId = q.filters.employeeId;
    if (q.filters.leaveTypeId) where.leaveTypeId = q.filters.leaveTypeId;
    if (q.search) {
      where.OR = [
        { number: { contains: q.search, mode: 'insensitive' } },
        { reason: { contains: q.search, mode: 'insensitive' } },
        { employee: { lastName: { contains: q.search, mode: 'insensitive' } } },
      ];
    }

    const [rows, total] = await Promise.all([
      prisma.leaveRequest.findMany({
        where,
        include: {
          employee: { select: { id: true, employeeNo: true, firstName: true, lastName: true } },
          leaveType: { select: { id: true, name: true, isPaid: true } },
        },
        orderBy: orderBy(q, ['number', 'startDate', 'createdAt'], { createdAt: 'desc' }),
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
      }),
      prisma.leaveRequest.count({ where }),
    ]);

    res.json(listResult(rows.map((r) => ({ ...r, days: num(r.days) })), total, q));
  }),
);

const leaveSchema = z.object({
  leaveTypeId: z.string().min(1, 'Which kind of leave?'),
  startDate: z.string().min(1, 'Start date is required'),
  startTime: z.string().optional().nullable(),
  endDate: z.string().min(1, 'End date is required'),
  endTime: z.string().optional().nullable(),
  reason: z.string().trim().min(3, 'Give a reason'),
  proofNote: z.string().optional().nullable(),
});

/** Previews the days a request would use, before it is filed. */
leaveRoutes.post(
  '/preview',
  handler(async (req, res) => {
    const me = currentUser(req);
    const body = parseBody(leaveSchema.omit({ reason: true, proofNote: true }), req.body);
    const settings = await hrSettings();

    const days = leaveDays(
      new Date(body.startDate),
      new Date(body.endDate),
      body.startTime || null,
      body.endTime || null,
      settings,
    );

    const mine = await myEmployee(me.id);
    const balance = mine
      ? await leaveBalance(mine.id, body.leaveTypeId, new Date(body.startDate).getFullYear())
      : null;

    res.json({
      days,
      balance,
      wouldExceed: balance ? days > balance.remainingAfterPending : false,
    });
  }),
);

leaveRoutes.post(
  '/',
  require_('ghr.leave.create'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const body = parseBody(leaveSchema, req.body);
    const settings = await hrSettings();

    const mine = await myEmployee(me.id);
    if (!mine) throw badRequest('Your account is not linked to an employee record');

    const start = new Date(body.startDate);
    const end = new Date(body.endDate);
    const days = leaveDays(start, end, body.startTime || null, body.endTime || null, settings);
    if (days <= 0) throw badRequest('That range contains no working days');

    const type = await prisma.leaveType.findUnique({ where: { id: body.leaveTypeId } });
    if (!type) throw notFound('Leave type not found');
    if (type.requiresProof && !body.proofNote) {
      throw badRequest(`${type.name} needs supporting documentation — note what you are attaching`);
    }

    // Overlapping leave is almost always a mistake, and silently allowing it
    // makes the balance wrong.
    const clash = await prisma.leaveRequest.findFirst({
      where: {
        employeeId: mine.id,
        status: { in: ['PENDING_APPROVAL', 'APPROVED'] },
        startDate: { lte: end },
        endDate: { gte: start },
      },
    });
    if (clash) {
      throw badRequest(`${clash.number} already covers some of those dates`);
    }

    const request = await prisma.$transaction(async (tx) => {
      const number = await nextNumber('leave_request', tx);
      return tx.leaveRequest.create({
        data: {
          number,
          employeeId: mine.id,
          leaveTypeId: body.leaveTypeId,
          startDate: start,
          startTime: body.startTime || null,
          endDate: end,
          endTime: body.endTime || null,
          days: D(days),
          reason: body.reason,
          proofNote: body.proofNote || null,
        },
      });
    });

    await audit(
      {
        entityType: 'leave_request',
        entityId: request.id,
        action: 'CREATED',
        summary: `Filed ${request.number} — ${days} day(s) of ${type.name}`,
      },
      req,
    );
    res.status(201).json({ ...request, days: num(request.days) });
  }),
);

leaveRoutes.post(
  '/:id/submit',
  require_('ghr.leave.create'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const request = await prisma.leaveRequest.findUnique({
      where: { id: req.params.id },
      include: { employee: true, leaveType: true },
    });
    if (!request) throw notFound('Leave request not found');
    if (request.status !== 'DRAFT') throw badRequest('This request has already been submitted');

    const mine = await myEmployee(me.id);
    if (request.employeeId !== mine?.id && !me.isSuperAdmin) {
      throw forbidden('That is someone else’s leave request');
    }

    await prisma.leaveRequest.update({
      where: { id: request.id },
      data: { status: 'PENDING_APPROVAL' },
    });

    await submitForApproval({
      documentType: 'leave_request',
      documentId: request.id,
      documentNumber: request.number,
      subject: `${request.employee.firstName} ${request.employee.lastName} — ${num(request.days)} day(s) ${request.leaveType.name}`,
      link: `/g-hr/leave/${request.id}`,
      requesterId: me.id,
    });

    res.json({ ok: true });
  }),
);

/**
 * An approved leave request draws down the balance.
 *
 * Only on approval — a pending request is shown against the balance separately
 * so nobody over-commits, but it does not consume the entitlement until
 * somebody has said yes.
 */
onApprovalSettled('leave_request', async (approval, outcome) => {
  const request = await prisma.leaveRequest.findUnique({
    where: { id: approval.documentId },
    include: { employee: true, leaveType: true },
  });
  if (!request) return;

  if (outcome !== 'APPROVED') {
    await prisma.leaveRequest.update({ where: { id: request.id }, data: { status: 'REJECTED' } });
    return;
  }

  const year = request.startDate.getFullYear();
  await ensureBalance(request.employeeId, request.leaveTypeId, year);

  await prisma.$transaction(async (tx) => {
    await tx.leaveRequest.update({
      where: { id: request.id },
      data: { status: 'APPROVED', decidedAt: new Date() },
    });
    await tx.leaveBalance.update({
      where: {
        employeeId_leaveTypeId_year: {
          employeeId: request.employeeId,
          leaveTypeId: request.leaveTypeId,
          year,
        },
      },
      data: { used: { increment: request.days } },
    });
  });

  await audit({
    entityType: 'leave_request',
    entityId: request.id,
    action: 'APPROVED',
    summary: `${request.number} approved — ${num(request.days)} day(s) drawn from ${request.leaveType.name}`,
  });
});

leaveRoutes.post(
  '/:id/cancel',
  handler(async (req, res) => {
    const me = currentUser(req);
    const request = await prisma.leaveRequest.findUnique({ where: { id: req.params.id } });
    if (!request) throw notFound('Leave request not found');

    const mine = await myEmployee(me.id);
    if (request.employeeId !== mine?.id && !me.isSuperAdmin && !me.permissions.has('ghr.leave.edit_all')) {
      throw forbidden('That is someone else’s leave request');
    }
    if (request.status === 'CANCELLED') throw badRequest('Already cancelled');

    await prisma.$transaction(async (tx) => {
      // Cancelling approved leave gives the days back.
      if (request.status === 'APPROVED') {
        const year = request.startDate.getFullYear();
        await tx.leaveBalance
          .update({
            where: {
              employeeId_leaveTypeId_year: {
                employeeId: request.employeeId,
                leaveTypeId: request.leaveTypeId,
                year,
              },
            },
            data: { used: { decrement: request.days } },
          })
          .catch(() => {});
      }
      await tx.leaveRequest.update({ where: { id: request.id }, data: { status: 'CANCELLED' } });
      await tx.approvalRequest.updateMany({
        where: { documentType: 'leave_request', documentId: request.id, status: 'PENDING' },
        data: { status: 'CANCELLED', closedAt: new Date() },
      });
    });

    await audit(
      {
        entityType: 'leave_request',
        entityId: request.id,
        action: 'CANCELLED',
        summary: `${request.number} cancelled`,
      },
      req,
    );
    res.json({ ok: true });
  }),
);

// ════════════════════════════════════════════════════════════════════
//  OVERTIME
// ════════════════════════════════════════════════════════════════════

export const overtimeRoutes = Router();
overtimeRoutes.use(authenticate);

interface OtMoney {
  estimatedHours: Prisma.Decimal;
  actualHours: Prisma.Decimal | null;
  hourlyRate: Prisma.Decimal | null;
  multiplier: Prisma.Decimal | null;
  amount: Prisma.Decimal | null;
}

/** Decimals become numbers at the API boundary, and nowhere before it. */
function presentOt<T extends OtMoney>(ot: T) {
  return {
    ...ot,
    estimatedHours: num(ot.estimatedHours),
    actualHours: ot.actualHours == null ? null : num(ot.actualHours),
    hourlyRate: ot.hourlyRate == null ? null : num(ot.hourlyRate),
    multiplier: ot.multiplier == null ? null : num(ot.multiplier),
    amount: ot.amount == null ? null : num(ot.amount),
  };
}

overtimeRoutes.get(
  '/',
  requireAny('ghr.overtime.view_all', 'ghr.overtime.view_own'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const q = listQuery(req);
    const where: Prisma.OvertimeRequestWhereInput = {};

    const onlyOwn = !me.isSuperAdmin && !me.permissions.has('ghr.overtime.view_all');
    if (onlyOwn || q.scope === 'mine') {
      const mine = await myEmployee(me.id);
      where.employeeId = mine?.id ?? '__none__';
    }
    const stage = asEnum(OtStage, q.filters.stage);
    if (stage) where.stage = stage;
    if (q.filters.jobId) where.jobId = q.filters.jobId;
    if (q.filters.employeeId) where.employeeId = q.filters.employeeId;
    if (q.search) {
      where.OR = [
        { number: { contains: q.search, mode: 'insensitive' } },
        { reason: { contains: q.search, mode: 'insensitive' } },
        { employee: { lastName: { contains: q.search, mode: 'insensitive' } } },
      ];
    }

    const [rows, total] = await Promise.all([
      prisma.overtimeRequest.findMany({
        where,
        include: {
          employee: { select: { id: true, employeeNo: true, firstName: true, lastName: true } },
          job: { select: { id: true, number: true, name: true } },
          costCategory: { select: { id: true, name: true } },
        },
        orderBy: orderBy(q, ['number', 'date', 'createdAt'], { date: 'desc' }),
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
      }),
      prisma.overtimeRequest.count({ where }),
    ]);

    res.json(listResult(rows.map(presentOt), total, q));
  }),
);

/**
 * The projects and budget lines an overtime filing can be charged to.
 *
 * Deliberately not /jobs/lookup: somebody filing overtime has to name the job
 * they worked on, and that is not the same thing as having access to project
 * management. Names and numbers only — no values, no margins.
 */
overtimeRoutes.get(
  '/chargeable',
  require_('ghr.overtime.create'),
  handler(async (_req, res) => {
    const [jobs, categories] = await Promise.all([
      prisma.job.findMany({
        where: { status: { notIn: ['CANCELLED', 'TURNED_OVER'] } },
        select: { id: true, number: true, name: true },
        orderBy: { createdAt: 'desc' },
        take: 200,
      }),
      prisma.costCategory.findMany({
        where: { isActive: true },
        select: { id: true, name: true },
        orderBy: { sortOrder: 'asc' },
      }),
    ]);
    res.json({ jobs, categories });
  }),
);

overtimeRoutes.get(
  '/:id',
  requireAny('ghr.overtime.view_all', 'ghr.overtime.view_own'),
  handler(async (req, res) => {
    const ot = await prisma.overtimeRequest.findUnique({
      where: { id: req.params.id },
      include: {
        employee: {
          select: { id: true, employeeNo: true, firstName: true, lastName: true, position: true },
        },
        job: { select: { id: true, number: true, name: true } },
        costCategory: { select: { id: true, name: true } },
      },
    });
    if (!ot) throw notFound('Overtime request not found');

    const rate = await overtimeRate(ot.employeeId);
    res.json({
      ...presentOt(ot),
      rate,
      // The variance the approver has to acknowledge.
      variance:
        ot.actualHours != null
          ? Math.round((num(ot.actualHours) - num(ot.estimatedHours)) * 100) / 100
          : null,
    });
  }),
);

const priorSchema = z.object({
  date: z.string().min(1, 'Which day?'),
  plannedStart: z.string().min(1),
  plannedEnd: z.string().min(1),
  dinnerBreak: z.boolean().default(true),
  reason: z.string().trim().min(5, 'Say why the overtime is needed'),
  jobId: z.string().optional().nullable(),
  costCategoryId: z.string().optional().nullable(),
});

/** Preview the hours a prior filing would claim, before it is filed. */
overtimeRoutes.post(
  '/preview',
  handler(async (req, res) => {
    const me = currentUser(req);
    const body = parseBody(
      z.object({
        start: z.string(),
        end: z.string(),
        dinnerBreak: z.boolean().default(true),
      }),
      req.body,
    );
    const settings = await hrSettings();
    const hours = overtimeHours(body.start, body.end, body.dinnerBreak, settings);

    const mine = await myEmployee(me.id);
    const rate = mine ? await overtimeRate(mine.id) : null;

    res.json({
      hours,
      breakDeducted: body.dinnerBreak,
      rate,
      amount: rate ? cents(hours * rate.hourlyRate * rate.multiplier) : null,
      settings: {
        dinnerBreakStart: settings.dinnerBreakStart,
        dinnerBreakEnd: settings.dinnerBreakEnd,
        overtimeMultiplier: settings.overtimeMultiplier,
      },
    });
  }),
);

/**
 * Filing overtime BEFORE the work.
 *
 * "Make a prior approval so that before commencing work employee can have
 * evidence that they are allowed to work overtime." That is the whole point of
 * this step, so it is a separate approval cycle from the actual filing.
 */
overtimeRoutes.post(
  '/',
  require_('ghr.overtime.create'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const body = parseBody(priorSchema, req.body);
    const settings = await hrSettings();

    const mine = await myEmployee(me.id);
    if (!mine) throw badRequest('Your account is not linked to an employee record');

    const hours = overtimeHours(body.plannedStart, body.plannedEnd, body.dinnerBreak, settings);
    if (hours <= 0) throw badRequest('That range is zero hours once the break is deducted');

    const ot = await prisma.$transaction(async (tx) => {
      const number = await nextNumber('overtime_request', tx);
      return tx.overtimeRequest.create({
        data: {
          number,
          employeeId: mine.id,
          date: new Date(body.date),
          plannedStart: body.plannedStart,
          plannedEnd: body.plannedEnd,
          estimatedHours: D(hours),
          dinnerBreak: body.dinnerBreak,
          reason: body.reason,
          jobId: body.jobId || null,
          costCategoryId: body.costCategoryId || null,
        },
      });
    });

    await submitForApproval({
      documentType: 'overtime_prior',
      documentId: ot.id,
      documentNumber: ot.number,
      subject: `${mine.firstName} ${mine.lastName} — ${hours}h prior approval for ${body.date}`,
      link: `/g-hr/overtime/${ot.id}`,
      requesterId: me.id,
    });

    await audit(
      {
        entityType: 'overtime_request',
        entityId: ot.id,
        action: 'CREATED',
        summary: `${ot.number} filed for prior approval — ${hours}h estimated`,
      },
      req,
    );
    res.status(201).json(presentOt(ot));
  }),
);

/** Prior approval is authorisation to work, and nothing more. */
onApprovalSettled('overtime_prior', async (approval, outcome) => {
  const ot = await prisma.overtimeRequest.findUnique({ where: { id: approval.documentId } });
  if (!ot) return;

  await prisma.overtimeRequest.update({
    where: { id: ot.id },
    data:
      outcome === 'APPROVED'
        ? { stage: 'PRIOR_APPROVED', priorApprovedAt: new Date() }
        : { stage: 'REJECTED' },
  });

  await audit({
    entityType: 'overtime_request',
    entityId: ot.id,
    action: outcome === 'APPROVED' ? 'APPROVED' : 'REJECTED',
    summary:
      outcome === 'APPROVED'
        ? `${ot.number} authorised — the work may go ahead. No cost has posted.`
        : `${ot.number} prior approval rejected`,
  });
});

/**
 * Filing the actual hours after the work.
 *
 * Any variance against the estimate is recorded and shown to the approver —
 * "a menu to set what actual finished of work if didn't tally the estimated
 * hours".
 */
overtimeRoutes.post(
  '/:id/actual',
  require_('ghr.overtime.create'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const body = parseBody(
      z.object({
        actualStart: z.string().min(1),
        actualEnd: z.string().min(1),
        dinnerBreak: z.boolean().optional(),
        varianceNote: z.string().optional().nullable(),
        jobId: z.string().optional().nullable(),
        costCategoryId: z.string().optional().nullable(),
      }),
      req.body,
    );

    const ot = await prisma.overtimeRequest.findUnique({
      where: { id: req.params.id },
      include: { employee: true },
    });
    if (!ot) throw notFound('Overtime request not found');

    const mine = await myEmployee(me.id);
    if (ot.employeeId !== mine?.id && !me.isSuperAdmin) {
      throw forbidden('That is someone else’s overtime');
    }
    if (ot.stage !== 'PRIOR_APPROVED') {
      throw badRequest(
        ot.stage === 'PRIOR'
          ? 'This overtime has not been authorised yet — the actual hours can only be filed once the prior approval is granted.'
          : `This overtime is ${ot.stage.toLowerCase().replace(/_/g, ' ')} and cannot be re-filed.`,
      );
    }

    const settings = await hrSettings();
    const dinnerBreak = body.dinnerBreak ?? ot.dinnerBreak;
    const hours = overtimeHours(body.actualStart, body.actualEnd, dinnerBreak, settings);
    if (hours <= 0) throw badRequest('That range is zero hours once the break is deducted');

    const variance = Math.round((hours - num(ot.estimatedHours)) * 100) / 100;
    if (Math.abs(variance) > 0.01 && !body.varianceNote) {
      throw badRequest(
        `The actual ${hours}h differs from the ${num(ot.estimatedHours)}h approved. Explain the difference — the approver sees it.`,
      );
    }

    const updated = await prisma.overtimeRequest.update({
      where: { id: ot.id },
      data: {
        stage: 'ACTUAL_FILED',
        actualStart: body.actualStart,
        actualEnd: body.actualEnd,
        actualHours: D(hours),
        dinnerBreak,
        varianceNote: body.varianceNote || null,
        ...(body.jobId !== undefined ? { jobId: body.jobId || null } : {}),
        ...(body.costCategoryId !== undefined ? { costCategoryId: body.costCategoryId || null } : {}),
      },
    });

    const rate = await overtimeRate(ot.employeeId);
    const amount = cents(hours * rate.hourlyRate * rate.multiplier);

    await submitForApproval({
      documentType: 'overtime_request',
      documentId: ot.id,
      documentNumber: ot.number,
      subject: `${ot.employee.firstName} ${ot.employee.lastName} — ${hours}h actual${
        Math.abs(variance) > 0.01 ? ` (${variance > 0 ? '+' : ''}${variance}h vs estimate)` : ''
      }`,
      amount,
      link: `/g-hr/overtime/${ot.id}`,
      requesterId: me.id,
    });

    res.json(presentOt(updated));
  }),
);

/**
 * The rule this whole phase exists to honour (model §4.4).
 *
 * The workflow has TWO steps — the supervisor who directed the work, then HR.
 * This subscriber fires only when the approval has SETTLED, which means both
 * have approved. Cost reaches the project's budget at that moment and not
 * before.
 */
onApprovalSettled('overtime_request', async (approval, outcome) => {
  const ot = await prisma.overtimeRequest.findUnique({
    where: { id: approval.documentId },
    include: { employee: true, job: true, costCategory: true },
  });
  if (!ot) return;

  if (outcome !== 'APPROVED') {
    await prisma.overtimeRequest.update({ where: { id: ot.id }, data: { stage: 'REJECTED' } });
    await audit({
      entityType: 'overtime_request',
      entityId: ot.id,
      action: 'REJECTED',
      summary: `${ot.number} rejected — no cost posted`,
    });
    return;
  }

  const hours = num(ot.actualHours);
  const rate = await overtimeRate(ot.employeeId);
  const amount = cents(hours * rate.hourlyRate * rate.multiplier);

  await prisma.$transaction(async (tx) => {
    await tx.overtimeRequest.update({
      where: { id: ot.id },
      data: {
        stage: 'APPROVED',
        hourlyRate: D(rate.hourlyRate),
        multiplier: D(rate.multiplier),
        amount: D(amount),
        postedAt: ot.jobId ? new Date() : null,
      },
    });

    // Only a job-assigned overtime posts. Overtime with no project is approved
    // for payroll but has no budget line to charge.
    if (ot.jobId && ot.costCategoryId && amount > 0) {
      await postJobCost(tx, {
        jobId: ot.jobId,
        costCategoryId: ot.costCategoryId,
        state: 'INCURRED',
        amount,
        sourceType: 'overtime_request',
        sourceId: ot.id,
        sourceNumber: ot.number,
        description: `${ot.employee.firstName} ${ot.employee.lastName} — ${hours}h overtime`,
      });
    }
  });

  await audit({
    entityType: 'overtime_request',
    entityId: ot.id,
    action: 'APPROVED',
    summary: rate.missingRate
      ? // The hours are approved and the employee is owed them; what is missing
        // is the rate needed to charge a project. Say so, rather than letting a
        // zero-peso ledger entry read as free labour.
        `${ot.number} approved — ${hours}h, but ${ot.employee.firstName} ${ot.employee.lastName} has no daily rate on file, so nothing could be charged to a project`
      : ot.jobId
        ? `${ot.number} approved by supervisor and HR — ${hours}h charged to ${ot.job?.number}`
        : `${ot.number} approved — ${hours}h, no project charged`,
  });

  if (ot.jobId) {
    const job = await prisma.job.findUnique({
      where: { id: ot.jobId },
      select: { projectManagerId: true, number: true },
    });
    if (job?.projectManagerId) {
      await notify({
        userId: job.projectManagerId,
        type: 'system',
        title: `Overtime charged to ${job.number}`,
        body: `${hours}h — ${ot.employee.firstName} ${ot.employee.lastName}`,
        link: `/g-ops/projects/${ot.jobId}`,
      });
    }
  }
});

overtimeRoutes.post(
  '/:id/cancel',
  handler(async (req, res) => {
    const me = currentUser(req);
    const ot = await prisma.overtimeRequest.findUnique({ where: { id: req.params.id } });
    if (!ot) throw notFound('Overtime request not found');

    const mine = await myEmployee(me.id);
    if (ot.employeeId !== mine?.id && !me.isSuperAdmin && !me.permissions.has('ghr.overtime.edit_all')) {
      throw forbidden('That is someone else’s overtime');
    }
    if (ot.stage === 'APPROVED') {
      throw badRequest('This overtime has already been approved and charged — it cannot be cancelled');
    }

    await prisma.$transaction(async (tx) => {
      await tx.overtimeRequest.update({ where: { id: ot.id }, data: { stage: 'CANCELLED' } });
      await tx.approvalRequest.updateMany({
        where: {
          documentType: { in: ['overtime_prior', 'overtime_request'] },
          documentId: ot.id,
          status: 'PENDING',
        },
        data: { status: 'CANCELLED', closedAt: new Date() },
      });
    });

    res.json({ ok: true });
  }),
);

// ════════════════════════════════════════════════════════════════════
//  HR SETTINGS & REPORTS
// ════════════════════════════════════════════════════════════════════

export const hrSettingsRoutes = Router();
hrSettingsRoutes.use(authenticate);

hrSettingsRoutes.get(
  '/',
  require_('ghr.settings.view_all'),
  handler(async (_req, res) => {
    res.json(await hrSettings());
  }),
);

hrSettingsRoutes.put(
  '/',
  require_('ghr.settings.edit_all'),
  handler(async (req, res) => {
    const body = parseBody(
      z.object({
        workStart: z.string().optional(),
        workEnd: z.string().optional(),
        graceMinutes: z.number().int().min(0).max(120).optional(),
        breakMinutes: z.number().int().min(0).max(240).optional(),
        dinnerBreakStart: z.string().optional(),
        dinnerBreakEnd: z.string().optional(),
        dinnerBreakMinutes: z.number().int().min(0).max(240).optional(),
        overtimeMultiplier: z.number().min(1).max(5).optional(),
        hoursPerDay: z.number().min(1).max(24).optional(),
        faceThreshold: z.number().min(0.3).max(0.9).optional(),
        probationMonths: z.number().int().min(1).max(24).optional(),
        evaluationMilestoneMonths: z.array(z.number().int().min(1).max(24)).max(6).optional(),
        evaluationNoticeDays: z.number().int().min(0).max(90).optional(),
        ratingScale: z.number().int().min(2).max(10).optional(),
        ratingLabels: z.array(z.string().trim().min(1)).max(10).optional(),
      }),
      req.body,
    );

    // Validate the time strings before they are stored.
    for (const key of ['workStart', 'workEnd', 'dinnerBreakStart', 'dinnerBreakEnd'] as const) {
      if (body[key]) toMinutes(body[key]!);
    }
    if (body.workStart && body.workEnd && toMinutes(body.workEnd) <= toMinutes(body.workStart)) {
      throw badRequest('The working day ends before it starts');
    }

    // The labels are the scale: one per point, checked against what will be
    // stored rather than only what was sent, so changing one without the
    // other cannot leave a rating with no name.
    const current = await hrSettings();
    const scale = body.ratingScale ?? current.ratingScale;
    const labels = body.ratingLabels ?? current.ratingLabels;
    if (labels.length !== scale) {
      throw badRequest(`A ${scale}-point scale needs ${scale} labels — ${labels.length} given`);
    }
    if (body.evaluationMilestoneMonths) {
      const months = body.evaluationMilestoneMonths;
      const probation = body.probationMonths ?? current.probationMonths;
      if (months.some((m, i) => i > 0 && m <= months[i - 1])) {
        throw badRequest('Evaluation milestones must be in ascending order');
      }
      if (months.some((m) => m >= probation)) {
        throw badRequest(`Every milestone must fall before the end of probation (${probation} months)`);
      }
    }

    const saved = await saveHrSettings(body);
    await audit(
      { entityType: 'setting', entityId: 'hr.rules', action: 'UPDATED', summary: 'Updated HR rules' },
      req,
    );
    res.json(saved);
  }),
);

/*
  HR's own lists — the clearance checklist and the evaluation criteria. Each
  is a Setting holding a JSON array, edited through one card on HR Settings,
  and each key carries its own row schema so the route is a whitelist: a key
  that is not named here is not a list anyone can write.

  The evaluation criteria are a list rather than a table on purpose: the
  evaluation form snapshots each criterion's name and weight when it is
  created, so a renamed or retired criterion never rewrites a signed form,
  and a foreign key would have bought nothing but a fourth CRUD screen.
*/
const checklistRow = z.object({
  area: z.enum(['SUPERVISOR', 'WAREHOUSE', 'FINANCE', 'HR', 'ADMIN']),
  description: z.string().trim().min(3, 'Say what is to be returned or cleared'),
});

const criterionRow = z.object({
  key: z.string().trim().regex(/^[A-Z0-9_]{2,12}$/, 'A key is 2–12 capitals, digits or underscores'),
  name: z.string().trim().min(2),
  description: z.string().trim().optional().nullable(),
  appliesTo: z.enum(['PROBATIONARY', 'TRAINEE', 'BOTH']),
  weight: z.number().min(0.1).max(10),
  sortOrder: z.number().int(),
  isActive: z.boolean(),
});

const SETTING_LISTS = {
  'hr.clearanceChecklist': {
    description: 'Company property and accountabilities every leaver clears, by area',
    schema: z.array(checklistRow).max(40),
  },
  'hr.evaluationCriteria': {
    description: 'What an evaluation rates, with weights — snapshotted onto each form',
    schema: z.array(criterionRow).max(30),
  },
} as const;

type SettingListKey = keyof typeof SETTING_LISTS;

function settingListKey(raw: string): SettingListKey {
  if (!(raw in SETTING_LISTS)) throw notFound(`"${raw}" is not an HR settings list`);
  return raw as SettingListKey;
}

hrSettingsRoutes.get(
  '/lists/:key',
  require_('ghr.settings.view_all'),
  handler(async (req, res) => {
    const key = settingListKey(req.params.key);
    res.json({ key, rows: await settingList<unknown>(key, []) });
  }),
);

hrSettingsRoutes.put(
  '/lists/:key',
  require_('ghr.settings.edit_all'),
  handler(async (req, res) => {
    const key = settingListKey(req.params.key);
    const { rows } = parseBody(z.object({ rows: SETTING_LISTS[key].schema }), req.body);

    if (key === 'hr.evaluationCriteria') {
      const keys = (rows as z.infer<typeof criterionRow>[]).map((r) => r.key);
      const dup = keys.find((k, i) => keys.indexOf(k) !== i);
      if (dup) throw badRequest(`Criterion key "${dup}" is used twice`);
    }

    await prisma.setting.upsert({
      where: { key },
      create: { key, value: rows as Prisma.InputJsonValue, description: SETTING_LISTS[key].description },
      update: { value: rows as Prisma.InputJsonValue },
    });
    await audit(
      { entityType: 'setting', entityId: key, action: 'UPDATED', summary: `Updated ${key} (${rows.length} rows)` },
      req,
    );
    res.json({ key, rows });
  }),
);

export const hrReportRoutes = Router();
hrReportRoutes.use(authenticate);

/** Overtime by project — what the labour is actually costing each job. */
hrReportRoutes.get(
  '/overtime-by-project',
  require_('ghr.reports.view_all'),
  handler(async (req, res) => {
    const from = req.query.from ? new Date(String(req.query.from)) : new Date(new Date().getFullYear(), 0, 1);
    const to = req.query.to ? new Date(String(req.query.to)) : new Date();

    const rows = await prisma.overtimeRequest.findMany({
      where: { stage: 'APPROVED', date: { gte: dayKey(from), lte: dayKey(to) }, jobId: { not: null } },
      include: {
        job: { select: { id: true, number: true, name: true } },
        employee: { select: { firstName: true, lastName: true } },
      },
      orderBy: { date: 'asc' },
    });

    const byJob = new Map<string, { job: { id: string; number: string; name: string }; hours: number; amount: number; entries: number }>();
    for (const r of rows) {
      if (!r.job) continue;
      const entry = byJob.get(r.job.id) ?? { job: r.job, hours: 0, amount: 0, entries: 0 };
      entry.hours += num(r.actualHours);
      entry.amount += num(r.amount);
      entry.entries += 1;
      byJob.set(r.job.id, entry);
    }

    res.json({
      from: dayKey(from),
      to: dayKey(to),
      jobs: [...byJob.values()].map((e) => ({
        ...e,
        hours: Math.round(e.hours * 100) / 100,
        amount: cents(e.amount),
      })),
      totalHours: Math.round(rows.reduce((s, r) => s + num(r.actualHours), 0) * 100) / 100,
      totalAmount: cents(rows.reduce((s, r) => s + num(r.amount), 0)),
    });
  }),
);

/** Leave balances across the team. */
hrReportRoutes.get(
  '/leave-balances',
  require_('ghr.reports.view_all'),
  handler(async (req, res) => {
    const year = Number(req.query.year ?? new Date().getFullYear());
    const [employees, types] = await Promise.all([
      prisma.employee.findMany({
        where: { isActive: true },
        select: { id: true, employeeNo: true, firstName: true, lastName: true },
        orderBy: { lastName: 'asc' },
      }),
      prisma.leaveType.findMany({ where: { isActive: true }, orderBy: { sortOrder: 'asc' } }),
    ]);

    const rows = [];
    for (const employee of employees) {
      const balances = [];
      for (const type of types) {
        balances.push({ typeId: type.id, ...(await leaveBalance(employee.id, type.id, year)) });
      }
      rows.push({ employee, balances });
    }

    res.json({
      year,
      types: types.map((t) => ({ id: t.id, code: t.code, name: t.name })),
      rows,
    });
  }),
);

