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
  idsFilter,
  notFound,
  badRequest,
  forbidden,
  type ListQuery,
} from '../http/kit';
import { authenticate, require_, requireAny, currentUser } from '../auth/middleware';
import { audit } from '../shared/audit';
import { nextNumber } from '../shared/numbering';
import { notify } from '../shared/notifications';
import {
  submitForApproval,
  onApprovalSettled,
  approversForStep,
  cancelOpenRequest,
  pickWorkflow,
  type ApprovalOutcome,
} from '../shared/approvals';
import { registerSearch } from '../shared/search';
import { can, canEditRecord, type ResolvedUser } from '../permissions/resolve';
import { postJobCost } from '../shared/inventory';
import { upload, saveAttachment, attachmentPath, deleteAttachment } from '../shared/attachments';
import { describeFace, faceEngineReady } from '../shared/face';
import { toCsv } from '../shared/csv';
import { sweepSeparations } from '../shared/clearance';
import {
  renderDocument,
  formatAmount,
  formatMoney,
  formatShortDate,
  statusLabel,
  companyCurrency,
} from '../shared/pdf';
import { LIST_CAP, listDay, listReference, rangeNamed, sendListPdf, totalLabel, choice, filterDay, dayOf } from '../shared/listPaper';
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

/**
 * Whether one person may read one leave or overtime record.
 *
 * The list routes scope by owner; a single record needs the same answer, plus
 * one more door: whoever the approval engine has put the document in front of.
 * A supervisor holding only `.view_own` who is asked to decide a leave request
 * must be able to open it — deciding on a notification's subject line alone is
 * approving blind. Anyone else holding only the own-scope key gets a 403.
 */
async function mayReadHrRecord(
  me: ResolvedUser,
  viewAllKey: string,
  ownerEmployeeId: string,
  documentTypes: string[],
  documentId: string,
): Promise<boolean> {
  if (can(me, viewAllKey)) return true;
  const mine = await myEmployee(me.id);
  if (mine && mine.id === ownerEmployeeId) return true;
  return isApproverOf(me.id, documentTypes, documentId);
}

/**
 * Refuses, before anything is written, exactly what `submitForApproval` would
 * refuse — no active workflow for the amount, or a first step that routes to
 * nobody or only to the requester — and nothing more. It asks the engine's own
 * `pickWorkflow` and `approversForStep` under the engine's two conditions, so
 * overtime is held to the rule leave and every other document are held to at
 * submission (a "Reports to" who has since been deactivated is the engine's
 * business, not a refusal of HR's own). Read-only: a filing it refuses burns
 * no number, and a filing being changed is never withdrawn from its approver
 * only to find it cannot be sent again.
 */
async function assertRoutable(documentType: string, amount: number | null, requesterId: string) {
  const workflow = await pickWorkflow(documentType, amount);
  if (!workflow || !workflow.steps.length) {
    throw badRequest(
      `No approval workflow is configured for "${documentType}". Set one up in Admin › Approval Workflows.`,
    );
  }
  const first = workflow.steps[0];
  const approvers = await approversForStep(first, requesterId);
  const stuck = !approvers.length || approvers.every((id) => id === requesterId);
  if (!stuck) return;

  // The real cause, where it is a person's "Reports to" rather than the route.
  let fix = approvers.length
    ? 'Add another approver to that step in Admin › Approval Workflows.'
    : 'Check that someone holds that role in Admin › Approval Workflows.';
  if (first.approverType === 'SUPERVISOR') {
    const requester = await prisma.user.findUnique({ where: { id: requesterId }, select: { supervisorId: true } });
    fix =
      requester?.supervisorId === requesterId
        ? 'Their "Reports to" names themselves — ask an administrator to set it in Admin › Users.'
        : 'They have no "Reports to", and nobody else holds the role it falls back to — ask an administrator to set ' +
          '"Reports to" in Admin › Users.';
  }
  throw badRequest(
    approvers.length
      ? `"${workflow.name}" routes step 1 ("${first.name}") only to the person who filed it, and nobody may approve their own filing. ${fix}`
      : `"${workflow.name}" routes step 1 ("${first.name}") to nobody. ${fix}`,
  );
}

/** What a pull-back or a change says when a decision got there first. */
const DECIDED_MEANWHILE = 'It was decided a moment ago — reload to see where it stands';

/**
 * Whether a decision reached the document's latest request: approved,
 * rejected, or returned (which the engine closes CANCELLED with a RETURNED
 * action) — as against withdrawn, or never opened at all.
 *
 * Asked when `cancelOpenRequest` found nothing open on a document that still
 * reads as waiting. Either a decision got there first (its subscriber is about
 * to apply it, so the change must stand aside), or the document was STRANDED:
 * filed while the engine refused it, before the filing routes put a refusal
 * back, so it reads "awaiting" with nobody asked. A stranded one has nothing
 * to withdraw and nothing to wait for, so the change goes ahead.
 */
async function decisionLanded(
  documentType: string,
  documentId: string,
  tx: Prisma.TransactionClient,
): Promise<boolean> {
  const last = await tx.approvalRequest.findFirst({
    where: { documentType, documentId },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    select: { status: true, actions: { where: { action: 'RETURNED' }, select: { id: true }, take: 1 } },
  });
  if (!last) return false;
  return last.status === 'APPROVED' || last.status === 'REJECTED' || (last.status === 'CANCELLED' && last.actions.length > 0);
}

/**
 * Withdraws a waiting document's open request, in the caller's transaction,
 * and refuses (rolling the caller's claim back) when a decision got there
 * first. Returns false for a STRANDED document — nothing was open, and no
 * decision is coming — so the caller can say so.
 */
async function withdrawOrRefuse(
  documentType: string,
  documentId: string,
  tx: Prisma.TransactionClient,
  reason: string,
  actorId: string,
): Promise<boolean> {
  const withdrawn = await cancelOpenRequest(documentType, documentId, tx, reason, actorId);
  if (withdrawn.length) return true;
  if (await decisionLanded(documentType, documentId, tx)) throw badRequest(DECIDED_MEANWHILE);
  return false;
}

/** Has acted on, or is eligible to act on the current step of, this document. */
async function isApproverOf(userId: string, documentTypes: string[], documentId: string): Promise<boolean> {
  const requests = await prisma.approvalRequest.findMany({
    where: { documentType: { in: documentTypes }, documentId },
    include: {
      actions: { select: { approverId: true } },
      workflow: { include: { steps: true } },
    },
  });
  for (const request of requests) {
    if (request.actions.some((a) => a.approverId === userId)) return true;
    if (request.status !== 'PENDING') continue;
    const step = request.workflow?.steps.find((s) => s.sequence === request.currentSequence);
    if (step && (await approversForStep(step, request.requesterId)).includes(userId)) return true;
  }
  return false;
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
      /*
        Somebody who can open the employee register gets a way to fix it rather
        than a message to pass on: the unlinked record that carries this login's
        employee number, when there is one. Nobody else sees it — it names an
        employee record, and the register is HR's.
      */
      let candidate: { id: string; employeeNo: string; name: string } | null = null;
      if (can(me, 'ghr.employees.view_all')) {
        const user = await prisma.user.findUnique({ where: { id: me.id }, select: { employeeNo: true } });
        const match = user?.employeeNo
          ? await prisma.employee.findFirst({
              where: { employeeNo: user.employeeNo, userId: null },
              select: { id: true, employeeNo: true, firstName: true, lastName: true },
            })
          : null;
        if (match) {
          candidate = { id: match.id, employeeNo: match.employeeNo, name: `${match.firstName} ${match.lastName}` };
        }
      }
      res.json({
        employee: null,
        message:
          'Your user account is not linked to an employee record, so attendance cannot be recorded. Ask HR to link it.',
        candidate,
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

    // Somebody separated yesterday is still flagged active until a sweep runs,
    // and nothing else guarantees one ran today. Narrowed to the caller: this
    // route only needs their own flag to be true, and an HR screen sweeps the
    // rest when it opens.
    await sweepSeparations(undefined, { userId: me.id });

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

/**
 * The attendance list's where-builder — the dashboard's list and its printed
 * twin read the same set: a day or a range of days, a status, a person, a
 * search, and with `?ids=` the rows ticked. A date that is not one is a 400,
 * never a 500 from the database.
 */
function attendanceListWhere(q: ListQuery): Prisma.AttendanceWhereInput {
  const where: Prisma.AttendanceWhereInput = {};
  const f = q.filters;
  const from = filterDay(f.from, 'From');
  const to = filterDay(f.to, 'To');
  const on = filterDay(f.date, 'Date');
  if (from || to) where.date = { ...(from ? { gte: dayOf(from) } : {}), ...(to ? { lte: dayOf(to) } : {}) };
  else if (on) where.date = dayOf(on);
  const status = choice(f.status, AttendanceStatus, 'Status');
  if (status) where.status = status;
  if (f.employeeId) where.employeeId = f.employeeId;
  if (q.search) {
    where.employee = {
      OR: [
        { firstName: { contains: q.search, mode: 'insensitive' } },
        { lastName: { contains: q.search, mode: 'insensitive' } },
        { employeeNo: { contains: q.search, mode: 'insensitive' } },
      ],
    };
  }
  const ids = idsFilter(f.ids);
  if (ids) where.id = { in: ids };
  return where;
}

const ATTENDANCE_SORTS = ['date', 'timeIn'];

attendanceRoutes.get(
  '/',
  require_('ghr.dashboard.view_all'),
  handler(async (req, res) => {
    const q = listQuery(req);
    const where = attendanceListWhere(q);

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
        orderBy: orderBy(q, ATTENDANCE_SORTS, { date: 'desc' }),
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

/** A clock time on paper, in Manila: "8:05 AM". */
const clockTime = new Intl.DateTimeFormat('en-PH', {
  timeZone: 'Asia/Manila',
  hour: 'numeric',
  minute: '2-digit',
  hour12: true,
});
const clockText = (d: Date | null) => (d ? clockTime.format(d).replace(/\s+/g, ' ').toUpperCase() : '—');

/**
 * The attendance list on paper — the dashboard's list as filtered (or the
 * rows ticked), through `attendanceListWhere`: who clocked in and out when,
 * how late, how long, and how they were identified. The match scores and
 * the photos stay on the screen — the photo is evidence, not a column.
 * Declared above `/:id`, like every printed list.
 */
attendanceRoutes.get(
  '/pdf',
  require_('ghr.dashboard.view_all'),
  handler(async (req, res) => {
    const q = listQuery(req);
    const where = attendanceListWhere(q);
    const f = q.filters;
    const [rows, count, employee] = await Promise.all([
      prisma.attendance.findMany({
        where,
        include: {
          employee: {
            select: { employeeNo: true, firstName: true, lastName: true, department: { select: { name: true } } },
          },
        },
        orderBy: orderBy(q, ATTENDANCE_SORTS, { date: 'desc' }),
        take: LIST_CAP,
      }),
      prisma.attendance.count({ where }),
      f.employeeId ? prisma.employee.findUnique({ where: { id: f.employeeId }, select: { firstName: true, lastName: true } }) : null,
    ]);

    const status = choice(f.status, AttendanceStatus, 'Status');
    const reference = listReference(count, rows.length, ['attendance row', 'attendance rows'], [
      q.search && `search "${q.search}"`,
      f.from || f.to ? rangeNamed('dated', f.from, f.to) : f.date && `on ${listDay(f.date)}`,
      status && `status ${statusLabel(status)}`,
      f.employeeId && `employee ${employee ? `${employee.firstName} ${employee.lastName}` : 'not found'}`,
      f.ids && 'the rows selected',
    ]);

    // Eight columns: landscape (rule 6).
    const pdf = await renderDocument({
      title: 'Attendance',
      date: new Date(),
      reference,
      landscape: true,
      sections: [
        {
          kind: 'table',
          head: ['Date', 'Employee', 'In', 'Out', 'Late (min)', 'Hours', 'Identified by', 'Status'],
          align: ['left', 'left', 'left', 'left', 'right', 'right', 'left', 'left'],
          rows: rows.map((r) => [
            formatShortDate(r.date),
            {
              title: `${r.employee.lastName}, ${r.employee.firstName}`,
              body: [r.employee.employeeNo, r.employee.department?.name].filter(Boolean).join(' · '),
            },
            clockText(r.timeIn),
            clockText(r.timeOut),
            r.lateMinutes ? String(r.lateMinutes) : '—',
            r.workedMinutes ? (r.workedMinutes / 60).toFixed(2) : '—',
            r.timeInMethod ? statusLabel(r.timeInMethod) : '—',
            statusLabel(r.status),
          ]),
        },
      ],
    });
    await audit(
      { entityType: 'attendance', entityId: 'list', action: 'EXPORTED', summary: `Exported the attendance list as PDF (${rows.length} row(s))` },
      req,
    );
    sendListPdf(res, pdf, 'attendance.pdf');
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

/**
 * The leave list's where-builder — the screen's rows and the printed list
 * read the same set. A `view_own` holder (or `?scope=mine`) sees their own
 * filings; `?ids=` narrows to the rows ticked, ANDed with that rule.
 */
async function leaveListWhere(me: ResolvedUser, q: ListQuery): Promise<Prisma.LeaveRequestWhereInput> {
  const and: Prisma.LeaveRequestWhereInput[] = [];
  const onlyOwn = !me.isSuperAdmin && !me.permissions.has('ghr.leave.view_all');
  if (onlyOwn || q.scope === 'mine') {
    const mine = await myEmployee(me.id);
    and.push({ employeeId: mine?.id ?? '__none__' });
  }
  const f = q.filters;
  const status = choice(f.status, LeaveStatus, 'Status');
  if (status) and.push({ status });
  if (f.employeeId) and.push({ employeeId: f.employeeId });
  if (f.leaveTypeId) and.push({ leaveTypeId: f.leaveTypeId });
  if (q.search) {
    and.push({
      OR: [
        { number: { contains: q.search, mode: 'insensitive' } },
        { reason: { contains: q.search, mode: 'insensitive' } },
        { employee: { lastName: { contains: q.search, mode: 'insensitive' } } },
      ],
    });
  }
  const ids = idsFilter(f.ids);
  if (ids) and.push({ id: { in: ids } });
  return { AND: and };
}

const LEAVE_SORTS = ['number', 'startDate', 'createdAt'];

leaveRoutes.get(
  '/',
  requireAny('ghr.leave.view_all', 'ghr.leave.view_own'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const q = listQuery(req);
    const where = await leaveListWhere(me, q);

    const [rows, total] = await Promise.all([
      prisma.leaveRequest.findMany({
        where,
        include: {
          employee: { select: { id: true, employeeNo: true, firstName: true, lastName: true } },
          leaveType: { select: { id: true, name: true, isPaid: true } },
        },
        orderBy: orderBy(q, LEAVE_SORTS, { createdAt: 'desc' }),
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
      }),
      prisma.leaveRequest.count({ where }),
    ]);

    res.json(listResult(rows.map((r) => ({ ...r, days: num(r.days) })), total, q));
  }),
);

/**
 * The leave list on paper — the list as filtered (or the rows ticked),
 * through `leaveListWhere`, so the paper is the screen it was printed off.
 * Declared above `/:id`, or that route swallows it.
 */
leaveRoutes.get(
  '/pdf',
  requireAny('ghr.leave.view_all', 'ghr.leave.view_own'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const q = listQuery(req);
    const where = await leaveListWhere(me, q);
    const f = q.filters;
    const [rows, count, employee, leaveType] = await Promise.all([
      prisma.leaveRequest.findMany({
        where,
        include: {
          employee: { select: { employeeNo: true, firstName: true, lastName: true } },
          leaveType: { select: { name: true, isPaid: true } },
        },
        orderBy: orderBy(q, LEAVE_SORTS, { createdAt: 'desc' }),
        take: LIST_CAP,
      }),
      prisma.leaveRequest.count({ where }),
      f.employeeId ? prisma.employee.findUnique({ where: { id: f.employeeId }, select: { firstName: true, lastName: true } }) : null,
      f.leaveTypeId ? prisma.leaveType.findUnique({ where: { id: f.leaveTypeId }, select: { name: true } }) : null,
    ]);

    const status = choice(f.status, LeaveStatus, 'Status');
    const reference = listReference(count, rows.length, ['leave request', 'leave requests'], [
      q.search && `search "${q.search}"`,
      status && `status ${statusLabel(status)}`,
      f.leaveTypeId && `type ${leaveType?.name ?? 'not found'}`,
      f.employeeId && `employee ${employee ? `${employee.firstName} ${employee.lastName}` : 'not found'}`,
      (q.scope === 'mine' || (!me.isSuperAdmin && !me.permissions.has('ghr.leave.view_all'))) && 'mine only',
      f.ids && 'the rows selected',
    ]);
    /** A day as a list prints it, with the time a half day carries. */
    const at = (d: Date, time: string | null) => (time ? `${formatShortDate(d)} ${time}` : formatShortDate(d));

    // Eight columns: landscape (rule 6).
    const pdf = await renderDocument({
      title: 'Leave Requests',
      date: new Date(),
      reference,
      landscape: true,
      sections: [
        {
          kind: 'table',
          head: ['Number', 'Employee', 'Leave type', 'From', 'To', 'Days', 'Reason', 'Status'],
          align: ['left', 'left', 'left', 'left', 'left', 'right', 'left', 'left'],
          rows: rows.map((r) => [
            r.number,
            { title: `${r.employee.lastName}, ${r.employee.firstName}`, body: r.employee.employeeNo },
            { title: r.leaveType.name, body: r.leaveType.isPaid ? 'Paid' : 'Unpaid' },
            at(r.startDate, r.startTime),
            at(r.endDate, r.endTime),
            String(num(r.days)),
            r.reason,
            statusLabel(r.status),
          ]),
        },
      ],
    });
    await audit(
      { entityType: 'leave_request', entityId: 'list', action: 'EXPORTED', summary: `Exported the leave list as PDF (${rows.length} request(s))` },
      req,
    );
    sendListPdf(res, pdf, 'leave-requests.pdf');
  }),
);

/**
 * One leave request, so an approval notification (`/g-hr/leave/:id`) lands on
 * the request rather than on the register. The LAST GET on this router: the
 * literal `/types` and `/balances` above must match before `/:id` can.
 *
 * Same shape as a list row, plus `proofNote` — the supporting documentation is
 * what an approver of sick leave is actually deciding on.
 */
leaveRoutes.get(
  '/:id',
  requireAny('ghr.leave.view_all', 'ghr.leave.view_own'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const request = await prisma.leaveRequest.findUnique({
      where: { id: req.params.id },
      include: {
        employee: { select: { id: true, employeeNo: true, firstName: true, lastName: true, userId: true } },
        leaveType: { select: { id: true, name: true, isPaid: true } },
      },
    });
    if (!request) throw notFound('Leave request not found');

    const readable = await mayReadHrRecord(
      me,
      'ghr.leave.view_all',
      request.employeeId,
      ['leave_request'],
      request.id,
    );
    if (!readable) throw forbidden('That is someone else’s leave request');

    const own = request.employee.userId === me.id;
    const editable = canEditRecord(me, 'ghr', 'leave', request.employee.userId);
    const { userId: _userId, ...employee } = request.employee;
    res.json({
      ...request,
      employee,
      days: num(request.days),
      // Mirrors POST /:id/cancel exactly, so the button is never offered to
      // somebody the route would refuse.
      canCancel:
        request.status !== 'CANCELLED' &&
        request.status !== 'REJECTED' &&
        (own || me.isSuperAdmin || me.permissions.has('ghr.leave.edit_all')),
      // PUT /:id, POST /:id/submit and POST /:id/withdraw, likewise.
      canModify: request.status === 'DRAFT' && editable,
      canSubmit: request.status === 'DRAFT' && can(me, 'ghr.leave.create') && (own || me.isSuperAdmin),
      canWithdraw: request.status === 'PENDING_APPROVAL' && editable,
    });
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

type LeaveBody = z.infer<typeof leaveSchema>;

/**
 * What a leave request's type and dates must pass — on filing and on every
 * change to a draft, so a modified request is held to exactly the rules the
 * new one was. `exceptId` leaves the request itself out of the clash check.
 */
async function checkLeave(body: LeaveBody, employeeId: string, exceptId?: string) {
  const settings = await hrSettings();
  const start = asDate(body.startDate) as Date;
  const end = asDate(body.endDate) as Date;
  const days = leaveDays(start, end, body.startTime || null, body.endTime || null, settings);
  if (days <= 0) throw badRequest('That range contains no working days');

  const type = await prisma.leaveType.findUnique({ where: { id: body.leaveTypeId } });
  if (!type) throw notFound('Leave type not found');
  if (type.requiresProof && !body.proofNote) {
    throw badRequest(`${type.name} needs supporting documentation — note what you are attaching`);
  }

  await refuseClash(employeeId, start, end, exceptId);
  return { start, end, days, type };
}

/**
 * Overlapping leave is almost always a mistake, and silently allowing it makes
 * the balance wrong. Only requests with an approver or approved count: a draft
 * is with nobody, which is why submitting runs this again.
 */
async function refuseClash(employeeId: string, start: Date, end: Date, exceptId?: string) {
  const clash = await prisma.leaveRequest.findFirst({
    where: {
      employeeId,
      status: { in: ['PENDING_APPROVAL', 'APPROVED'] },
      startDate: { lte: end },
      endDate: { gte: start },
      ...(exceptId ? { id: { not: exceptId } } : {}),
    },
  });
  if (clash) {
    throw badRequest(`${clash.number} already covers some of those dates`);
  }
}

/** A stored request, as the body that filed it — so a submission is held to the filing's own rules. */
function leaveBodyOf(r: {
  leaveTypeId: string;
  startDate: Date;
  endDate: Date;
  startTime: string | null;
  endTime: string | null;
  reason: string;
  proofNote: string | null;
}): LeaveBody {
  return {
    leaveTypeId: r.leaveTypeId,
    // A DATE column is UTC midnight of its day, so its ISO date is that day.
    startDate: r.startDate.toISOString().slice(0, 10),
    endDate: r.endDate.toISOString().slice(0, 10),
    startTime: r.startTime,
    endTime: r.endTime,
    reason: r.reason,
    proofNote: r.proofNote,
  };
}

/**
 * A leave request the caller may change: the employee's own (edit_own), or
 * anybody's with edit_all — `canEditRecord`, on the login behind the employee.
 */
async function leaveForEdit(me: ResolvedUser, id: string) {
  const request = await prisma.leaveRequest.findUnique({
    where: { id },
    include: { employee: true, leaveType: true },
  });
  if (!request) throw notFound('Leave request not found');
  if (!canEditRecord(me, 'ghr', 'leave', request.employee.userId)) {
    throw forbidden('That is someone else’s leave request');
  }
  return request;
}

leaveRoutes.post(
  '/',
  require_('ghr.leave.create'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const body = parseBody(leaveSchema, req.body);

    const mine = await myEmployee(me.id);
    if (!mine) throw badRequest('Your account is not linked to an employee record');

    const { start, end, days, type } = await checkLeave(body, mine.id);

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

    // Every rule the filing passed, again, on the draft as it is stored: the
    // clash check ignores drafts, so two drafts for the same days — or one
    // pulled back while another was filed over its days — would otherwise
    // both reach an approver, and both draw the balance. The days are counted
    // again too (a draft may predate a change to the working week), and what
    // is counted now is what the approver is asked and the balance draws.
    const { days, type } = await checkLeave(leaveBodyOf(request), request.employeeId, request.id);

    // Claimed on the draft exactly as it was read — `updatedAt` too — so a
    // change saved a moment ago and this submission cannot both land: the
    // approver is never sent a subject the record no longer says.
    const claimed = await prisma.leaveRequest.updateMany({
      where: { id: request.id, status: 'DRAFT', updatedAt: request.updatedAt },
      data: { status: 'PENDING_APPROVAL', days: D(days) },
    });
    if (!claimed.count) {
      const now = await prisma.leaveRequest.findUnique({ where: { id: request.id }, select: { status: true } });
      throw badRequest(
        now?.status === 'DRAFT'
          ? 'It was changed a moment ago — reload to see the change, then submit it'
          : 'This request has already been submitted',
      );
    }

    try {
      // Once more, now this one is claimed: two overlapping drafts submitted
      // at the same moment each see the other here, so both cannot pass.
      await refuseClash(request.employeeId, request.startDate, request.endDate, request.id);
      await submitForApproval({
        documentType: 'leave_request',
        documentId: request.id,
        documentNumber: request.number,
        subject: `${request.employee.firstName} ${request.employee.lastName} — ${days} day(s) ${type.name}`,
        link: `/g-hr/leave/${request.id}`,
        // The employee's own login, whoever pressed the button: a super admin
        // sending somebody's draft on must not leave that person free to
        // approve their own leave.
        requesterId: request.employee.userId ?? me.id,
      });
    } catch (err) {
      // A clash, no workflow, or nobody to route to: the request goes back to
      // DRAFT rather than reading "pending" with no approval behind it.
      await prisma.leaveRequest.updateMany({
        where: { id: request.id, status: 'PENDING_APPROVAL' },
        data: { status: 'DRAFT', days: request.days },
      });
      throw err;
    }

    await audit(
      {
        entityType: 'leave_request',
        entityId: request.id,
        action: 'SUBMITTED',
        summary: `${request.number} sent for approval`,
      },
      req,
    );
    res.json({ ok: true });
  }),
);

/**
 * Changing a draft. Only a DRAFT: a submitted request's dates and days are
 * what the approver is deciding on, so it is pulled back first (below). The
 * days are counted again and every check the filing passed is run again —
 * zero working days, the type's proof, a clash with another request — with
 * the request itself left out of the clash. Claimed on DRAFT, so a
 * submission that lands first wins and this change is refused.
 */
leaveRoutes.put(
  '/:id',
  requireAny('ghr.leave.edit_own', 'ghr.leave.edit_all'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const body = parseBody(leaveSchema, req.body);
    const existing = await leaveForEdit(me, req.params.id);
    if (existing.status !== 'DRAFT') {
      throw badRequest(
        existing.status === 'PENDING_APPROVAL'
          ? 'Only a draft can be changed — pull this one back from the approver first'
          : `Only a draft can be changed — this one is ${existing.status.toLowerCase().replace(/_/g, ' ')}`,
      );
    }

    const { start, end, days, type } = await checkLeave(body, existing.employeeId, existing.id);
    const fields = {
      leaveTypeId: body.leaveTypeId,
      startDate: start,
      startTime: body.startTime || null,
      endDate: end,
      endTime: body.endTime || null,
      days: D(days),
      reason: body.reason,
      proofNote: body.proofNote || null,
    };
    // Claimed on the draft as it was read, `updatedAt` too: a submission or
    // another change that lands first wins, and the trail's "before" below is
    // never a version somebody else had already replaced.
    const claimed = await prisma.leaveRequest.updateMany({
      where: { id: existing.id, status: 'DRAFT', updatedAt: existing.updatedAt },
      data: fields,
    });
    if (!claimed.count) {
      const now = await prisma.leaveRequest.findUnique({ where: { id: existing.id }, select: { status: true } });
      throw badRequest(
        now?.status === 'DRAFT'
          ? 'It was changed a moment ago — reload to see that change before making yours'
          : 'It was submitted a moment ago — reload to see where it stands',
      );
    }
    const updated = await prisma.leaveRequest.findUniqueOrThrow({ where: { id: existing.id } });

    const facts = (r: typeof existing | typeof updated) => ({
      leaveTypeId: r.leaveTypeId,
      startDate: r.startDate,
      startTime: r.startTime,
      endDate: r.endDate,
      endTime: r.endTime,
      days: num(r.days),
      reason: r.reason,
      proofNote: r.proofNote,
    });
    await audit(
      {
        entityType: 'leave_request',
        entityId: existing.id,
        action: 'UPDATED',
        summary: `${existing.number} changed — ${days} day(s) of ${type.name}`,
        before: facts(existing),
        after: facts(updated),
      },
      req,
    );
    res.json({ ...updated, days: num(updated.days) });
  }),
);

/**
 * Pulling a request back from the approver to change it, as a sales order
 * is: claimed PENDING_APPROVAL → DRAFT, and the open request withdrawn
 * through the engine in the same transaction — the approver is told. When
 * nothing was withdrawn because a decision got there first, the whole
 * pull-back rolls back and the decision is applied as it stands; when
 * nothing was open and no decision came (`withdrawOrRefuse`), it goes ahead.
 */
leaveRoutes.post(
  '/:id/withdraw',
  requireAny('ghr.leave.edit_own', 'ghr.leave.edit_all'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const request = await leaveForEdit(me, req.params.id);
    if (request.status !== 'PENDING_APPROVAL') {
      throw badRequest('This request is not with the approver — nothing to pull back');
    }

    const withdrawn = await prisma.$transaction(async (tx) => {
      const claimed = await tx.leaveRequest.updateMany({
        where: { id: request.id, status: 'PENDING_APPROVAL' },
        data: { status: 'DRAFT' },
      });
      if (!claimed.count) throw badRequest(DECIDED_MEANWHILE);
      return withdrawOrRefuse('leave_request', request.id, tx, `pulled back to draft by ${me.name}`, me.id);
    });

    await audit(
      {
        entityType: 'leave_request',
        entityId: request.id,
        action: 'UPDATED',
        summary: `${request.number} pulled back to draft${withdrawn ? '' : ' — nothing was with an approver'}`,
      },
      req,
    );
    res.json({ ok: true, status: 'DRAFT' });
  }),
);

/** How a filing's trail names where it had moved on to, where the state's own name would mislead. */
const MOVED_ON: Record<string, string> = {
  DRAFT: 'pulled back to draft',
  // Only an actual filing's decision can find PRIOR_APPROVED: the hours were pulled back.
  PULLED_BACK: 'pulled back',
};

/**
 * A decision that reaches a filing after it moved on — cancelled or pulled
 * back while the last approver was deciding — changes nothing. The engine
 * keeps the decision as its record of fact; the filing's trail says why it
 * did not follow.
 */
async function decidedTooLate(
  entityType: 'leave_request' | 'overtime_request',
  entityId: string,
  what: string,
  outcome: ApprovalOutcome,
  movedOn: string,
) {
  await audit({
    entityType,
    entityId,
    action: 'UPDATED',
    summary: `${what} was ${outcome.toLowerCase()} after it was ${MOVED_ON[movedOn] ?? movedOn.toLowerCase().replace(/_/g, ' ')} — not applied`,
  });
}

/**
 * An approved leave request draws down the balance.
 *
 * Only on approval — a pending request is shown against the balance separately
 * so nobody over-commits, but it does not consume the entitlement until
 * somebody has said yes. And only while the request is still
 * PENDING_APPROVAL, claimed with a conditional update: one cancelled while the
 * approver was deciding stays cancelled and draws nothing.
 */
onApprovalSettled('leave_request', async (approval, outcome) => {
  const request = await prisma.leaveRequest.findUnique({
    where: { id: approval.documentId },
    include: { employee: true, leaveType: true },
  });
  if (!request) return;

  const year = request.startDate.getFullYear();
  if (outcome === 'APPROVED') await ensureBalance(request.employeeId, request.leaveTypeId, year);

  // The status the request had moved on to, or null once it took the outcome.
  const movedOn = await prisma.$transaction(async (tx) => {
    const claimed = await tx.leaveRequest.updateMany({
      where: { id: request.id, status: 'PENDING_APPROVAL' },
      data: outcome === 'APPROVED' ? { status: 'APPROVED', decidedAt: new Date() } : { status: 'REJECTED' },
    });
    if (!claimed.count) {
      return (await tx.leaveRequest.findUnique({ where: { id: request.id }, select: { status: true } }))?.status ?? request.status;
    }
    if (outcome === 'APPROVED') {
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
    }
    return null;
  });

  if (movedOn) {
    await decidedTooLate('leave_request', request.id, request.number, outcome, movedOn);
    return;
  }
  if (outcome !== 'APPROVED') return;

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
      // Still with the approver: withdrawn through the engine, so it leaves
      // their queue and they are told.
      await cancelOpenRequest('leave_request', request.id, tx, `cancelled by ${me.name}`, me.id);
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

/**
 * The overtime list's where-builder — the screen's rows and the printed list
 * read the same set. A `view_own` holder (or `?scope=mine`) sees their own
 * filings; `?ids=` narrows to the rows ticked, ANDed with that rule.
 */
async function overtimeListWhere(me: ResolvedUser, q: ListQuery): Promise<Prisma.OvertimeRequestWhereInput> {
  const and: Prisma.OvertimeRequestWhereInput[] = [];
  const onlyOwn = !me.isSuperAdmin && !me.permissions.has('ghr.overtime.view_all');
  if (onlyOwn || q.scope === 'mine') {
    const mine = await myEmployee(me.id);
    and.push({ employeeId: mine?.id ?? '__none__' });
  }
  const f = q.filters;
  const stage = choice(f.stage, OtStage, 'Stage', (st) => OT_STAGE_LABEL[st]);
  if (stage) and.push({ stage });
  if (f.jobId) and.push({ jobId: f.jobId });
  if (f.employeeId) and.push({ employeeId: f.employeeId });
  if (q.search) {
    and.push({
      OR: [
        { number: { contains: q.search, mode: 'insensitive' } },
        { reason: { contains: q.search, mode: 'insensitive' } },
        { employee: { lastName: { contains: q.search, mode: 'insensitive' } } },
      ],
    });
  }
  const ids = idsFilter(f.ids);
  if (ids) and.push({ id: { in: ids } });
  return { AND: and };
}

const OVERTIME_SORTS = ['number', 'date', 'createdAt'];

/**
 * An overtime stage in the words the screen uses — the pill and the Stage
 * filter (`STAGES` in web/src/pages/hr/Overtime.tsx). The paper prints these,
 * never `statusLabel`'s "Prior approved", so it says what the screen it was
 * printed from says. Change both together.
 */
export const OT_STAGE_LABEL: Record<OtStage, string> = {
  PRIOR: 'Awaiting authorisation',
  PRIOR_APPROVED: 'Authorised — work it',
  ACTUAL_FILED: 'Actual filed, awaiting approval',
  APPROVED: 'Approved and charged',
  REJECTED: 'Rejected',
  CANCELLED: 'Cancelled',
};

overtimeRoutes.get(
  '/',
  requireAny('ghr.overtime.view_all', 'ghr.overtime.view_own'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const q = listQuery(req);
    const where = await overtimeListWhere(me, q);

    const [rows, total] = await Promise.all([
      prisma.overtimeRequest.findMany({
        where,
        include: {
          employee: { select: { id: true, employeeNo: true, firstName: true, lastName: true } },
          job: { select: { id: true, number: true, name: true } },
          costCategory: { select: { id: true, name: true } },
        },
        orderBy: orderBy(q, OVERTIME_SORTS, { date: 'desc' }),
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
      }),
      prisma.overtimeRequest.count({ where }),
    ]);

    res.json(listResult(rows.map(presentOt), total, q));
  }),
);

/**
 * The overtime list on paper — the list as filtered (or the rows ticked),
 * through `overtimeListWhere`, so the paper is the screen it was printed
 * off. The cost is the screen's: the amount an approved filing was charged
 * at, never the hourly rate or the premium behind it — a project's paper
 * never carries a colleague's pay. The total runs over every filing the
 * filter matched, not only those printed. Declared above `/:id`, or that
 * route swallows it.
 */
overtimeRoutes.get(
  '/pdf',
  requireAny('ghr.overtime.view_all', 'ghr.overtime.view_own'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const q = listQuery(req);
    const where = await overtimeListWhere(me, q);
    const f = q.filters;
    const [rows, count, sums, currency, employee, job] = await Promise.all([
      prisma.overtimeRequest.findMany({
        where,
        select: {
          number: true,
          stage: true,
          date: true,
          plannedStart: true,
          plannedEnd: true,
          actualStart: true,
          actualEnd: true,
          estimatedHours: true,
          actualHours: true,
          reason: true,
          amount: true,
          employee: { select: { firstName: true, lastName: true } },
          job: { select: { number: true } },
          costCategory: { select: { name: true } },
        },
        orderBy: orderBy(q, OVERTIME_SORTS, { date: 'desc' }),
        take: LIST_CAP,
      }),
      prisma.overtimeRequest.count({ where }),
      prisma.overtimeRequest.aggregate({ where, _sum: { amount: true } }),
      companyCurrency(),
      f.employeeId ? prisma.employee.findUnique({ where: { id: f.employeeId }, select: { firstName: true, lastName: true } }) : null,
      f.jobId ? prisma.job.findUnique({ where: { id: f.jobId }, select: { number: true } }) : null,
    ]);

    const stage = choice(f.stage, OtStage, 'Stage', (st) => OT_STAGE_LABEL[st]);
    const reference = listReference(count, rows.length, ['overtime request', 'overtime requests'], [
      q.search && `search "${q.search}"`,
      stage && `stage ${OT_STAGE_LABEL[stage]}`,
      f.jobId && `project ${job?.number ?? 'not found'}`,
      f.employeeId && `employee ${employee ? `${employee.firstName} ${employee.lastName}` : 'not found'}`,
      (q.scope === 'mine' || (!me.isSuperAdmin && !me.permissions.has('ghr.overtime.view_all'))) && 'mine only',
      f.ids && 'the rows selected',
    ]);

    const pdf = await renderDocument({
      title: 'Overtime Requests',
      date: new Date(),
      reference,
      sections: [
        {
          kind: 'table',
          head: ['Number', 'Employee', 'Date', 'Hours', 'Charged to', `Cost (${currency})`, 'Stage'],
          align: ['left', 'left', 'left', 'right', 'left', 'right', 'left'],
          rows: rows.map((r) => [
            r.number,
            { title: `${r.employee.lastName}, ${r.employee.firstName}`, body: r.reason },
            {
              title: formatShortDate(r.date),
              body: `${r.actualStart ?? r.plannedStart}–${r.actualEnd ?? r.plannedEnd}`,
            },
            r.actualHours == null
              ? { title: String(num(r.estimatedHours)), body: 'estimated' }
              : String(num(r.actualHours)),
            r.job ? { title: r.job.number, body: r.costCategory?.name } : 'No project',
            r.amount == null ? '—' : formatAmount(num(r.amount)),
            OT_STAGE_LABEL[r.stage],
          ]),
        },
        {
          kind: 'totals',
          rows: [{ label: totalLabel('Approved cost', count, rows.length), value: formatMoney(num(sums._sum.amount), currency), bold: true }],
        },
      ],
    });
    await audit(
      { entityType: 'overtime_request', entityId: 'list', action: 'EXPORTED', summary: `Exported the overtime list as PDF (${rows.length} request(s))` },
      req,
    );
    sendListPdf(res, pdf, 'overtime-requests.pdf');
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
  handler(async (req, res) => {
    const me = currentUser(req);
    const mine = await myEmployee(me.id);
    const [jobs, categories, last] = await Promise.all([
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
      mine
        ? prisma.overtimeRequest.findFirst({
            where: { employeeId: mine.id, jobId: { not: null }, stage: { not: 'CANCELLED' } },
            orderBy: { createdAt: 'desc' },
            select: { jobId: true, costCategoryId: true },
          })
        : null,
    ]);

    /*
      What the filing form starts on. Overtime runs in streaks on one job — the
      commissioning that overran on Monday overruns on Tuesday — so the job
      and budget line of this person's last filing are the likeliest answer,
      while that job is still chargeable. The budget line otherwise defaults to
      labour, because overtime is labour whichever job it lands on.
    */
    const lastJobId = last?.jobId && jobs.some((j) => j.id === last.jobId) ? last.jobId : null;
    const lastCategoryId =
      lastJobId && last?.costCategoryId && categories.some((c) => c.id === last.costCategoryId)
        ? last.costCategoryId
        : null;
    const labour = categories.find((c) => /labou?r/i.test(c.name)) ?? null;
    res.json({
      jobs,
      categories,
      defaults: { jobId: lastJobId, costCategoryId: lastCategoryId ?? labour?.id ?? null },
    });
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
          select: { id: true, employeeNo: true, firstName: true, lastName: true, position: true, userId: true },
        },
        job: { select: { id: true, number: true, name: true } },
        costCategory: { select: { id: true, name: true } },
      },
    });
    if (!ot) throw notFound('Overtime request not found');

    // The list is scoped to one's own filings; the record was not, so anyone
    // holding only view_own could read a colleague's hours and burdened rate
    // by id. Same rule as a leave request: owner, view_all, or an approver.
    const me = currentUser(req);
    const readable = await mayReadHrRecord(
      me,
      'ghr.overtime.view_all',
      ot.employeeId,
      ['overtime_prior', 'overtime_request'],
      ot.id,
    );
    if (!readable) throw forbidden('That is someone else’s overtime');

    const rate = await overtimeRate(ot.employeeId);
    const own = (await myEmployee(me.id))?.id === ot.employeeId;
    const editable = canEditRecord(me, 'ghr', 'overtime', ot.employee.userId);
    const { userId: _userId, ...employee } = ot.employee;
    res.json({
      ...presentOt(ot),
      employee,
      rate,
      // The variance the approver has to acknowledge.
      variance:
        ot.actualHours != null
          ? Math.round((num(ot.actualHours) - num(ot.estimatedHours)) * 100) / 100
          : null,
      // Mirror POST /:id/actual and /:id/cancel, so an approver reading the
      // filing is not offered buttons the routes would refuse.
      canFileActual:
        ot.stage === 'PRIOR_APPROVED' && (own || me.isSuperAdmin) && can(me, 'ghr.overtime.create'),
      canCancel:
        ot.stage !== 'APPROVED' &&
        ot.stage !== 'CANCELLED' &&
        (own || me.isSuperAdmin || me.permissions.has('ghr.overtime.edit_all')),
      // PUT /:id and POST /:id/withdraw, likewise. The actual hours are pulled
      // back only by whoever may file them again.
      canModify: ot.stage === 'PRIOR' && editable,
      canWithdraw: ot.stage === 'ACTUAL_FILED' && editable && (own || me.isSuperAdmin),
      // The viewer's own filing — a form modifying somebody else's speaks of
      // them, and prices at their rate (`rate`), never the viewer's.
      own,
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

type PriorBody = z.infer<typeof priorSchema>;

/**
 * Where a filing's cost would be charged, checked on every route that writes
 * it — the prior filing, a change to it, and the actual hours: the project
 * must exist and still take overtime (the `/chargeable` rule), except the one
 * the filing already names, which it may keep; the budget line must exist.
 * Unchecked, a stray id was a foreign-key 500, and a closed project took cost.
 */
async function checkCharge(jobId: string | null, costCategoryId: string | null, keepJobId: string | null = null) {
  if (jobId && jobId !== keepJobId) {
    const job = await prisma.job.findUnique({ where: { id: jobId }, select: { status: true } });
    if (!job) throw badRequest('That project does not exist');
    if (job.status === 'CANCELLED' || job.status === 'TURNED_OVER') {
      throw badRequest('That project no longer takes overtime — it is closed');
    }
  }
  if (costCategoryId && !(await prisma.costCategory.findUnique({ where: { id: costCategoryId }, select: { id: true } }))) {
    throw badRequest('That budget line does not exist');
  }
}

/**
 * The planned side of a filing, checked — on filing and on every change
 * before authorisation, so a changed filing is held to the new one's rules.
 * The project must still take overtime (the `/chargeable` rule), except the
 * one the filing already names, which a change may keep.
 */
async function priorFields(body: PriorBody, keepJobId: string | null = null) {
  const settings = await hrSettings();
  const date = asDate(body.date) as Date;
  const hours = overtimeHours(body.plannedStart, body.plannedEnd, body.dinnerBreak, settings);
  if (hours <= 0) throw badRequest('That range is zero hours once the break is deducted');

  const jobId = body.jobId || null;
  const costCategoryId = body.costCategoryId || null;
  await checkCharge(jobId, costCategoryId, keepJobId);

  return {
    hours,
    data: {
      date,
      plannedStart: body.plannedStart,
      plannedEnd: body.plannedEnd,
      estimatedHours: D(hours),
      dinnerBreak: body.dinnerBreak,
      reason: body.reason,
      jobId,
      costCategoryId,
    },
  };
}

/**
 * An overtime filing the caller may change: the employee's own (edit_own), or
 * anybody's with edit_all — `canEditRecord`, on the login behind the employee.
 */
async function overtimeForEdit(me: ResolvedUser, id: string) {
  const ot = await prisma.overtimeRequest.findUnique({ where: { id }, include: { employee: true } });
  if (!ot) throw notFound('Overtime request not found');
  if (!canEditRecord(me, 'ghr', 'overtime', ot.employee.userId)) {
    throw forbidden('That is someone else’s overtime');
  }
  return ot;
}

const priorSubject = (employee: { firstName: string; lastName: string }, hours: number, date: string) =>
  `${employee.firstName} ${employee.lastName} — ${hours}h prior approval for ${date}`;

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

    const mine = await myEmployee(me.id);
    if (!mine) throw badRequest('Your account is not linked to an employee record');

    const { hours, data } = await priorFields(body);
    // Before the number: a filing the engine would refuse burns none.
    await assertRoutable('overtime_prior', null, me.id);

    const ot = await prisma.$transaction(async (tx) => {
      const number = await nextNumber('overtime_request', tx);
      return tx.overtimeRequest.create({ data: { number, employeeId: mine.id, ...data } });
    });

    try {
      await submitForApproval({
        documentType: 'overtime_prior',
        documentId: ot.id,
        documentNumber: ot.number,
        subject: priorSubject(mine, hours, body.date),
        link: `/g-hr/overtime/${ot.id}`,
        requesterId: me.id,
      });
    } catch (err) {
      // Refused after all (the workflow changed under the check above). A
      // prior filing has no draft to fall back to, and one reading "awaiting
      // authorisation" with nobody asked is the fault, so it goes: nothing
      // was recorded against it yet.
      await prisma.overtimeRequest.delete({ where: { id: ot.id } }).catch(() => {});
      throw err;
    }

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

/**
 * Changing a filing before it is authorised: the day, the planned times, the
 * reason, the project. The supervisor is deciding on exactly those, so the
 * change is not slipped under them — one transaction claims the filing
 * (still PRIOR), withdraws its request through the engine (they are told)
 * and writes the change; it is then sent again from the first step. When
 * nothing was withdrawn because a decision got there first, the change rolls
 * back; a filing stranded with nobody asked is simply sent. Once authorised (PRIOR_APPROVED) the planned times are what was
 * approved: cancel and file again. The actual hours change by pulling them
 * back (POST /:id/withdraw) and filing them again.
 */
overtimeRoutes.put(
  '/:id',
  requireAny('ghr.overtime.edit_own', 'ghr.overtime.edit_all'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const body = parseBody(priorSchema, req.body);
    const ot = await overtimeForEdit(me, req.params.id);
    if (ot.stage !== 'PRIOR') {
      throw badRequest(
        ot.stage === 'PRIOR_APPROVED'
          ? 'This overtime was authorised as planned, so the plan is what was approved — cancel it and file again to change it.'
          : ot.stage === 'ACTUAL_FILED'
            ? 'The actual hours are with the approver — pull them back to change them.'
            : `This overtime is ${ot.stage.toLowerCase().replace(/_/g, ' ')} and cannot be changed.`,
      );
    }

    const { hours, data } = await priorFields(body, ot.jobId);
    // Sent again in the employee's name, whoever changed it, so the
    // self-approval rule still keeps them off their own filing.
    const requesterId = ot.employee.userId ?? me.id;
    // Before anything is withdrawn: a change that could not be sent again
    // must not take the filing away from its approver.
    await assertRoutable('overtime_prior', null, requesterId);

    // `withdrew` is false for a filing stranded with nobody asked (filed
    // while the engine refused it): nothing to take back, so it is simply sent.
    const { updated, withdrew } = await prisma.$transaction(async (tx) => {
      const claimed = await tx.overtimeRequest.updateMany({
        where: { id: ot.id, stage: 'PRIOR', updatedAt: ot.updatedAt },
        data,
      });
      if (!claimed.count) {
        // Still waiting, so somebody else's change got there first; else decided.
        const now = await tx.overtimeRequest.findUnique({ where: { id: ot.id }, select: { stage: true } });
        throw badRequest(
          now?.stage === 'PRIOR' ? 'It was changed a moment ago — reload to see that change before making yours' : DECIDED_MEANWHILE,
        );
      }
      const withdrew = await withdrawOrRefuse('overtime_prior', ot.id, tx, `changed by ${me.name} and sent again`, me.id);
      return { updated: await tx.overtimeRequest.findUniqueOrThrow({ where: { id: ot.id } }), withdrew };
    });

    try {
      await submitForApproval({
        documentType: 'overtime_prior',
        documentId: ot.id,
        documentNumber: ot.number,
        subject: priorSubject(ot.employee, hours, body.date),
        link: `/g-hr/overtime/${ot.id}`,
        requesterId,
      });
    } catch (err) {
      // Refused after all (the workflow changed under the check above). A
      // filing "awaiting authorisation" with nobody asked is the fault, so
      // it is cancelled, and the trail and the answer say why.
      const why = err instanceof Error ? err.message : String(err);
      const cancelled = await prisma.overtimeRequest.updateMany({
        where: { id: ot.id, stage: 'PRIOR' },
        data: { stage: 'CANCELLED' },
      });
      if (cancelled.count) {
        await audit(
          {
            entityType: 'overtime_request',
            entityId: ot.id,
            action: 'CANCELLED',
            summary: `${ot.number} changed but could not be sent again (${why}) — cancelled`,
          },
          req,
        );
      }
      throw badRequest(`${why} — ${ot.number} could not be sent again, so it is cancelled. File it again once that is fixed.`);
    }

    await audit(
      {
        entityType: 'overtime_request',
        entityId: ot.id,
        action: 'UPDATED',
        summary: withdrew
          ? `${ot.number} changed before authorisation — ${hours}h estimated, sent again`
          : `${ot.number} changed before authorisation — ${hours}h estimated, sent for authorisation (nothing was with an approver)`,
        before: {
          date: ot.date,
          plannedStart: ot.plannedStart,
          plannedEnd: ot.plannedEnd,
          estimatedHours: num(ot.estimatedHours),
          dinnerBreak: ot.dinnerBreak,
          reason: ot.reason,
          jobId: ot.jobId,
          costCategoryId: ot.costCategoryId,
        },
        after: { ...data, estimatedHours: hours },
      },
      req,
    );
    res.json(presentOt(updated));
  }),
);

/**
 * Prior approval is authorisation to work, and nothing more — taken only by a
 * filing still waiting on it, claimed with a conditional update, so one
 * cancelled while the supervisor was deciding stays cancelled.
 */
onApprovalSettled('overtime_prior', async (approval, outcome) => {
  const ot = await prisma.overtimeRequest.findUnique({ where: { id: approval.documentId } });
  if (!ot) return;

  const claimed = await prisma.overtimeRequest.updateMany({
    where: { id: ot.id, stage: 'PRIOR' },
    data:
      outcome === 'APPROVED'
        ? { stage: 'PRIOR_APPROVED', priorApprovedAt: new Date() }
        : { stage: 'REJECTED' },
  });
  if (!claimed.count) {
    const now = await prisma.overtimeRequest.findUnique({ where: { id: ot.id }, select: { stage: true } });
    await decidedTooLate('overtime_request', ot.id, `The prior approval of ${ot.number}`, outcome, now?.stage ?? ot.stage);
    return;
  }

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

    // A project or budget line named now is held to the prior filing's rule.
    await checkCharge(
      body.jobId !== undefined ? body.jobId || null : null,
      body.costCategoryId !== undefined ? body.costCategoryId || null : null,
      ot.jobId,
    );

    const rate = await overtimeRate(ot.employeeId);
    const amount = cents(hours * rate.hourlyRate * rate.multiplier);
    // The employee's own login, whoever filed it (a super admin may), so the
    // self-approval rule keeps them off their own hours.
    const requesterId = ot.employee.userId ?? me.id;
    // Before anything is written: the amount picks the route.
    await assertRoutable('overtime_request', amount, requesterId);

    // Claimed on PRIOR_APPROVED, so a cancel or a second filing that lands
    // first wins.
    const claimed = await prisma.overtimeRequest.updateMany({
      where: { id: ot.id, stage: 'PRIOR_APPROVED' },
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
    if (!claimed.count) throw badRequest('It changed a moment ago — reload to see where it stands');
    const updated = await prisma.overtimeRequest.findUniqueOrThrow({ where: { id: ot.id } });

    try {
      await submitForApproval({
        documentType: 'overtime_request',
        documentId: ot.id,
        documentNumber: ot.number,
        subject: `${ot.employee.firstName} ${ot.employee.lastName} — ${hours}h actual${
          Math.abs(variance) > 0.01 ? ` (${variance > 0 ? '+' : ''}${variance}h vs estimate)` : ''
        }`,
        amount,
        link: `/g-hr/overtime/${ot.id}`,
        requesterId,
      });
    } catch (err) {
      // Refused after all: back to authorised-and-not-filed, as it was,
      // rather than "awaiting approval" with no approval behind it.
      await prisma.overtimeRequest.updateMany({
        where: { id: ot.id, stage: 'ACTUAL_FILED' },
        data: {
          stage: 'PRIOR_APPROVED',
          actualStart: ot.actualStart,
          actualEnd: ot.actualEnd,
          actualHours: ot.actualHours,
          dinnerBreak: ot.dinnerBreak,
          varianceNote: ot.varianceNote,
          jobId: ot.jobId,
          costCategoryId: ot.costCategoryId,
        },
      });
      throw err;
    }

    await audit(
      {
        entityType: 'overtime_request',
        entityId: ot.id,
        action: 'SUBMITTED',
        summary: `${ot.number} actual hours filed — ${hours}h${
          Math.abs(variance) > 0.01 ? ` (${variance > 0 ? '+' : ''}${variance}h vs estimate)` : ''
        }`,
      },
      req,
    );
    res.json(presentOt(updated));
  }),
);

/**
 * Pulling the actual hours back from the approvers to change them: claimed
 * ACTUAL_FILED → PRIOR_APPROVED (authorised, hours not yet filed), and the
 * open request withdrawn through the engine in the same transaction — the
 * approvers are told. The filed hours are cleared, so nothing reads them as
 * filed (the trail keeps them); filing them again is the change. Only
 * whoever may file them again may pull them back. When nothing was
 * withdrawn because a decision got there first, the pull-back rolls back;
 * hours stranded with nobody asked come back all the same.
 */
overtimeRoutes.post(
  '/:id/withdraw',
  requireAny('ghr.overtime.edit_own', 'ghr.overtime.edit_all'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const ot = await overtimeForEdit(me, req.params.id);
    if (ot.employee.userId !== me.id && !me.isSuperAdmin) {
      throw forbidden('Only the person who filed the hours can pull them back — cancel it instead');
    }
    if (ot.stage !== 'ACTUAL_FILED') {
      throw badRequest(
        ot.stage === 'PRIOR'
          ? 'The prior filing is still with the approver — modify it instead; it is sent again on saving.'
          : 'Only actual hours awaiting approval can be pulled back.',
      );
    }

    const withdrew = await prisma.$transaction(async (tx) => {
      const claimed = await tx.overtimeRequest.updateMany({
        where: { id: ot.id, stage: 'ACTUAL_FILED' },
        data: { stage: 'PRIOR_APPROVED', actualStart: null, actualEnd: null, actualHours: null, varianceNote: null },
      });
      if (!claimed.count) throw badRequest(DECIDED_MEANWHILE);
      return withdrawOrRefuse('overtime_request', ot.id, tx, `pulled back by ${me.name}`, me.id);
    });

    await audit(
      {
        entityType: 'overtime_request',
        entityId: ot.id,
        action: 'UPDATED',
        summary: `${ot.number} actual hours pulled back (${num(ot.actualHours)}h, ${ot.actualStart}–${ot.actualEnd}) — to be filed again${
          withdrew ? '' : ' (nothing was with an approver)'
        }`,
      },
      req,
    );
    res.json({ ok: true, stage: 'PRIOR_APPROVED' });
  }),
);

/**
 * The rule this whole phase exists to honour (model §4.4).
 *
 * The workflow has TWO steps — the supervisor who directed the work, then HR.
 * This subscriber fires only when the approval has SETTLED, which means both
 * have approved. Cost reaches the project's budget at that moment and not
 * before — and only for a filing whose actual hours still wait on this
 * approval, claimed with a conditional update. One cancelled while HR was
 * deciding stays cancelled, and nothing posts.
 */
onApprovalSettled('overtime_request', async (approval, outcome) => {
  const ot = await prisma.overtimeRequest.findUnique({
    where: { id: approval.documentId },
    include: { employee: true, job: true, costCategory: true },
  });
  if (!ot) return;
  // A filing back at PRIOR_APPROVED had its hours pulled back (POST /:id/withdraw).
  const stageNow = async () => {
    const stage =
      (await prisma.overtimeRequest.findUnique({ where: { id: ot.id }, select: { stage: true } }))?.stage ?? ot.stage;
    return stage === 'PRIOR_APPROVED' ? 'PULLED_BACK' : stage;
  };

  if (outcome !== 'APPROVED') {
    const claimed = await prisma.overtimeRequest.updateMany({
      where: { id: ot.id, stage: 'ACTUAL_FILED' },
      data: { stage: 'REJECTED' },
    });
    if (!claimed.count) {
      await decidedTooLate('overtime_request', ot.id, ot.number, outcome, await stageNow());
      return;
    }
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

  const applied = await prisma.$transaction(async (tx) => {
    const claimed = await tx.overtimeRequest.updateMany({
      where: { id: ot.id, stage: 'ACTUAL_FILED' },
      data: {
        stage: 'APPROVED',
        hourlyRate: D(rate.hourlyRate),
        multiplier: D(rate.multiplier),
        amount: D(amount),
        postedAt: ot.jobId ? new Date() : null,
      },
    });
    if (!claimed.count) return false;

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
    return true;
  });
  if (!applied) {
    await decidedTooLate('overtime_request', ot.id, ot.number, outcome, await stageNow());
    return;
  }

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
    if (ot.stage === 'CANCELLED') throw badRequest('Already cancelled');

    await prisma.$transaction(async (tx) => {
      await tx.overtimeRequest.update({ where: { id: ot.id }, data: { stage: 'CANCELLED' } });
      // Whichever filing is with the approver — the prior approval or the
      // actual hours — is withdrawn through the engine, and they are told.
      for (const documentType of ['overtime_prior', 'overtime_request']) {
        await cancelOpenRequest(documentType, ot.id, tx, `cancelled by ${me.name}`, me.id);
      }
    });

    await audit(
      {
        entityType: 'overtime_request',
        entityId: ot.id,
        action: 'CANCELLED',
        summary: `${ot.number} cancelled`,
      },
      req,
    );
    res.json({ ok: true });
  }),
);

// ── Global search ─────────────────────────────────────────────────────────────
// A leave or overtime filing is found by number, reason or the person's name.
// Own scope mirrors the list routes: holding only `.view_own`, you find your
// own filings and nobody else's.

registerSearch({
  kind: 'leave_request',
  label: 'Leave',
  permission: ['ghr.leave.view_all', 'ghr.leave.view_own'],
  ownWhere: (user) => ({ employee: { userId: user.id } }),
  search: async (term, _user, limit, own) => {
    const rows = await prisma.leaveRequest.findMany({
      where: {
        ...own,
        OR: [
          { number: { contains: term, mode: 'insensitive' } },
          { reason: { contains: term, mode: 'insensitive' } },
          { employee: { firstName: { contains: term, mode: 'insensitive' } } },
          { employee: { lastName: { contains: term, mode: 'insensitive' } } },
        ],
      },
      take: limit,
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        number: true,
        status: true,
        employee: { select: { firstName: true, lastName: true } },
        leaveType: { select: { name: true } },
      },
    });
    return rows.map((r) => ({
      kind: 'leave_request',
      id: r.id,
      title: `${r.number} — ${r.employee.firstName} ${r.employee.lastName}`,
      subtitle: `${r.leaveType.name} · ${r.status.toLowerCase().replace(/_/g, ' ')}`,
      link: `/g-hr/leave/${r.id}`,
    }));
  },
});

registerSearch({
  kind: 'overtime_request',
  label: 'Overtime',
  permission: ['ghr.overtime.view_all', 'ghr.overtime.view_own'],
  ownWhere: (user) => ({ employee: { userId: user.id } }),
  search: async (term, _user, limit, own) => {
    const rows = await prisma.overtimeRequest.findMany({
      where: {
        ...own,
        OR: [
          { number: { contains: term, mode: 'insensitive' } },
          { reason: { contains: term, mode: 'insensitive' } },
          { employee: { firstName: { contains: term, mode: 'insensitive' } } },
          { employee: { lastName: { contains: term, mode: 'insensitive' } } },
        ],
      },
      take: limit,
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        number: true,
        stage: true,
        employee: { select: { firstName: true, lastName: true } },
        job: { select: { number: true } },
      },
    });
    return rows.map((r) => ({
      kind: 'overtime_request',
      id: r.id,
      title: `${r.number} — ${r.employee.firstName} ${r.employee.lastName}`,
      subtitle: [r.job?.number, r.stage.toLowerCase().replace(/_/g, ' ')].filter(Boolean).join(' · '),
      link: `/g-hr/overtime/${r.id}`,
    }));
  },
});

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
        // The greetings card sends only this key; a partial object merges over
        // what is stored, so one template can change without the others.
        greetings: z
          .object({
            enabled: z.boolean(),
            hour: z.number().int().min(0).max(23),
            tellEveryone: z.boolean(),
            birthdayTitle: z.string().trim().min(1).max(120),
            birthdayMessage: z.string().trim().max(500),
            anniversaryTitle: z.string().trim().min(1).max(120),
            anniversaryMessage: z.string().trim().max(500),
            everyoneBirthday: z.string().trim().min(1).max(160),
            everyoneAnniversary: z.string().trim().min(1).max(160),
          })
          .partial()
          .optional(),
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

    const { greetings: greetingsPatch, ...rest } = body;
    const saved = await saveHrSettings({
      ...rest,
      ...(greetingsPatch ? { greetings: { ...current.greetings, ...greetingsPatch } } : {}),
    });
    await audit(
      { entityType: 'setting', entityId: 'hr.rules', action: 'UPDATED', summary: body.greetings && Object.keys(body).length === 1 ? 'Updated the greetings' : 'Updated HR rules' },
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

