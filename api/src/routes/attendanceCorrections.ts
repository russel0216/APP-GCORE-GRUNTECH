import { Router } from 'express';
import { z } from 'zod';
import { Prisma, type ApprovalRequest } from '@prisma/client';
import { prisma } from '../prisma';
import { handler, parseBody, listQuery, listResult, orderBy, notFound, badRequest, forbidden, idsFilter, deleteOrRefuse, type ListQuery } from '../http/kit';
import { authenticate, requireAny, requireAnyOrDecider, currentUser } from '../auth/middleware';
import { can, canEditRecord, type ResolvedUser } from '../permissions/resolve';
import { audit } from '../shared/audit';
import { nextNumber } from '../shared/numbering';
import {
  cancelOpenRequest,
  mayDecide,
  onApprovalSettled,
  onApprovalReopened,
  pendingFor,
  routeBrief,
  submitForApproval,
  type ApprovalOutcome,
} from '../shared/approvals';
import { renderDocument, formatShortDate, statusLabel } from '../shared/pdf';
import { LIST_CAP, listReference, sendListPdf, choice } from '../shared/listPaper';
import { manilaDate } from '../shared/day';
import { classifyArrival, hrSettings, undertimeMinutes, workedMinutes } from '../shared/hr';
import { filingRoute } from './hr';

/**
 * G-HR › ATTENDANCE CORRECTIONS (2026-10-23, the owner's report: "approval
 * of leave, overtime or attendance request not appearing to superior" —
 * there was no attendance request at all; a missed or wrong punch could only
 * be fixed by HR on the register). An employee asks for a day's time in
 * and/or time out to be corrected, with the reason; the route is the one
 * engine's `attendance_correction` — their supervisor ("Reports to"), then
 * HR — and APPROVAL writes the times onto the day's attendance row (MANUAL,
 * lateness, hours and undertime worked out again, the row as it stood kept
 * on the request), never before. Rejected stays rejected; a pending one is
 * pulled back to draft or cancelled; a draft, a rejected or a cancelled one
 * may be deleted.
 *
 * Who reads one: the person it is for, their direct superior, whoever may
 * decide its open step, and View All (HR). Who changes one: the person
 * (Edit Own on their own) or Edit All.
 */

export const attendanceCorrectionRoutes = Router();
attendanceCorrectionRoutes.use(authenticate);

const DOC = 'attendance_correction';
export const CORRECTION_LINK = (id: string) => `/g-hr/attendance-corrections/${id}`;
const KEYS = ['ghr.attendance_corrections.view_all', 'ghr.attendance_corrections.view_own'] as const;
const EDIT_KEYS = ['ghr.attendance_corrections.create', 'ghr.attendance_corrections.edit_own', 'ghr.attendance_corrections.edit_all'] as const;
const STATUSES = ['DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'REJECTED', 'CANCELLED'] as const;

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const today = () => manilaDate(new Date()).toISOString().slice(0, 10);
const keyOf = (d: Date) => d.toISOString().slice(0, 10);
const at = (day: string, hhmm: string) => new Date(`${day}T${hhmm}:00+08:00`);

/** The requested times as instants — a time out at or before the time in is the next morning (an overnight shift). */
export function correctedTimes(day: string, timeIn: string | null, timeOut: string | null, existingIn: Date | null) {
  const inAt = timeIn ? at(day, timeIn) : existingIn;
  let outAt = timeOut ? at(day, timeOut) : null;
  if (outAt && inAt && outAt.getTime() <= inAt.getTime()) outAt = new Date(outAt.getTime() + 24 * 60 * 60 * 1000);
  return { inAt, outAt };
}

const include = {
  employee: { select: { id: true, employeeNo: true, firstName: true, lastName: true, userId: true, user: { select: { supervisorId: true } } } },
  requestedBy: { select: { id: true, name: true } },
} satisfies Prisma.AttendanceCorrectionInclude;
type Row = Prisma.AttendanceCorrectionGetPayload<{ include: typeof include }>;

const nameOf = (e: { firstName: string; lastName: string }) => `${e.firstName} ${e.lastName}`.trim();
const ownerOf = (r: Row) => r.employee.userId;

async function myEmployeeId(userId: string) {
  return (await prisma.employee.findUnique({ where: { userId }, select: { id: true } }))?.id ?? null;
}

async function mayRead(me: ResolvedUser, r: Row): Promise<boolean> {
  if (me.isSuperAdmin || can(me, 'ghr.attendance_corrections.view_all')) return true;
  if (r.employee.userId === me.id) return true;
  if (r.employee.user?.supervisorId === me.id) return true;
  return mayDecide(me.id, DOC, [r.id]);
}

async function load(me: ResolvedUser, id: string): Promise<Row> {
  const row = await prisma.attendanceCorrection.findUnique({ where: { id }, include });
  if (!row || !(await mayRead(me, row))) throw notFound('Attendance correction not found');
  return row;
}

const mayChange = (me: ResolvedUser, r: Row) => canEditRecord(me, 'ghr', 'attendance_corrections', ownerOf(r));

async function present(me: ResolvedUser, r: Row, withRoute = false) {
  const editor = mayChange(me, r);
  const draft = r.status === 'DRAFT';
  const { userId: _u, user: _s, ...employee } = r.employee;
  const day = await prisma.attendance.findUnique({
    where: { employeeId_date: { employeeId: r.employeeId, date: r.date } },
    select: { timeIn: true, timeOut: true, status: true },
  });
  return {
    ...r,
    employee: { ...employee, name: nameOf(r.employee) },
    date: keyOf(r.date),
    /** The day's row as it stands now (before approval: what the correction would change). */
    current: day,
    canEdit: draft && editor,
    canSubmit: draft && editor,
    canWithdraw: r.status === 'PENDING_APPROVAL' && editor,
    canCancel: (draft || r.status === 'PENDING_APPROVAL') && editor,
    canDelete: ['DRAFT', 'REJECTED', 'CANCELLED'].includes(r.status) && editor && can(me, 'ghr.attendance_corrections.delete'),
    approvalRoute: withRoute && draft && r.employee.userId ? await routeBrief(DOC, null, r.employee.userId) : null,
  };
}

/** The ids whose open approval step waits on this user — My Work's own queue. */
async function waitingOn(userId: string) {
  return (await pendingFor(userId)).filter((r) => r.documentType === DOC).map((r) => r.documentId);
}

async function listWhere(me: ResolvedUser, q: ListQuery): Promise<Prisma.AttendanceCorrectionWhereInput> {
  const and: Prisma.AttendanceCorrectionWhereInput[] = [];
  const mine = await myEmployeeId(me.id);
  if (q.scope === 'mine') and.push({ employeeId: mine ?? '__none__' });
  else if (!me.isSuperAdmin && !can(me, 'ghr.attendance_corrections.view_all')) {
    const waiting = await waitingOn(me.id);
    and.push({
      OR: [
        { employeeId: mine ?? '__none__' },
        { employee: { user: { supervisorId: me.id } } },
        ...(waiting.length ? [{ id: { in: waiting } }] : []),
      ],
    });
  }
  const f = q.filters;
  const status = choice(f.status, STATUSES, 'Status');
  if (status) and.push({ status });
  if (choice(f.waiting, ['me'] as const, 'Waiting')) and.push({ id: { in: await waitingOn(me.id) } });
  if (f.reports === 'true') and.push({ employee: { user: { supervisorId: me.id } } });
  if (f.employeeId) and.push({ employeeId: f.employeeId });
  if (q.search) {
    and.push({
      OR: [
        { number: { contains: q.search, mode: 'insensitive' } },
        { reason: { contains: q.search, mode: 'insensitive' } },
        { employee: { lastName: { contains: q.search, mode: 'insensitive' } } },
        { employee: { firstName: { contains: q.search, mode: 'insensitive' } } },
      ],
    });
  }
  const ids = idsFilter(f.ids);
  if (ids) and.push({ id: { in: ids } });
  return { AND: and };
}

const SORTS = ['number', 'date', 'createdAt'];

attendanceCorrectionRoutes.get(
  '/',
  requireAny(...KEYS),
  handler(async (req, res) => {
    const me = currentUser(req);
    const q = listQuery(req);
    const where = await listWhere(me, q);
    const [rows, total] = await Promise.all([
      prisma.attendanceCorrection.findMany({ where, include, orderBy: orderBy(q, SORTS, { createdAt: 'desc' }), skip: (q.page - 1) * q.pageSize, take: q.pageSize }),
      prisma.attendanceCorrection.count({ where }),
    ]);
    res.json(
      listResult(
        rows.map((r) => {
          const { userId: _u, user: _s, ...employee } = r.employee;
          return { ...r, date: keyOf(r.date), employee: { ...employee, name: nameOf(r.employee) } };
        }),
        total,
        q,
      ),
    );
  }),
);

attendanceCorrectionRoutes.get(
  '/pdf',
  requireAny(...KEYS),
  handler(async (req, res) => {
    const me = currentUser(req);
    const q = listQuery(req);
    const where = await listWhere(me, q);
    const [rows, count] = await Promise.all([
      prisma.attendanceCorrection.findMany({ where, include, orderBy: orderBy(q, SORTS, { createdAt: 'desc' }), take: LIST_CAP }),
      prisma.attendanceCorrection.count({ where }),
    ]);
    const f = q.filters;
    const reference = listReference(count, rows.length, ['correction', 'corrections'], [
      q.search ? `search "${q.search}"` : null,
      f.status ? `status ${statusLabel(f.status).toLowerCase()}` : null,
      f.waiting === 'me' ? 'waiting on me' : null,
      f.reports === 'true' ? 'my direct reports' : null,
      q.scope === 'mine' ? 'my own' : null,
      f.ids ? 'the rows selected' : null,
    ]);
    const pdf = await renderDocument({
      title: 'Attendance Corrections',
      date: new Date(),
      reference,
      sections: [
        {
          kind: 'table',
          head: ['Number', 'Employee', 'Date', 'Time in', 'Time out', 'Reason', 'Status'],
          rows: rows.map((r) => [
            r.number,
            nameOf(r.employee),
            formatShortDate(r.date),
            r.timeIn ?? '—',
            r.timeOut ?? '—',
            r.reason,
            statusLabel(r.status),
          ]),
        },
      ],
    });
    await audit({ entityType: DOC, entityId: 'list', action: 'EXPORTED', summary: `Exported the attendance corrections as PDF (${listReference(count, rows.length, ['correction', 'corrections'], [])})` }, req);
    sendListPdf(res, pdf, 'attendance-corrections.pdf');
  }),
);

const body = z
  .object({
    date: z.string().regex(DAY, 'The date is YYYY-MM-DD'),
    timeIn: z.string().regex(HHMM, 'Time in is HH:MM').nullable().optional(),
    timeOut: z.string().regex(HHMM, 'Time out is HH:MM').nullable().optional(),
    reason: z.string().trim().min(5, 'Say why the time needs correcting').max(1000),
    /** HR filing for somebody (Edit All); anyone else files for themself. */
    employeeId: z.string().optional(),
  })
  .refine((b) => b.timeIn || b.timeOut, { message: 'Give the time in, the time out, or both', path: ['timeIn'] });

async function checkDay(employeeId: string, date: string, exceptId: string | null) {
  if (date > today()) throw badRequest('A day still to come cannot be corrected');
  const open = await prisma.attendanceCorrection.findFirst({
    where: { employeeId, date: new Date(`${date}T00:00:00Z`), status: { in: ['DRAFT', 'PENDING_APPROVAL'] }, ...(exceptId ? { id: { not: exceptId } } : {}) },
    select: { number: true },
  });
  if (open) throw badRequest(`${open.number} already asks to correct that day — modify it instead`);
}

attendanceCorrectionRoutes.post(
  '/',
  requireAny('ghr.attendance_corrections.create'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const b = parseBody(body, req.body);
    let employeeId = await myEmployeeId(me.id);
    if (b.employeeId && b.employeeId !== employeeId) {
      if (!can(me, 'ghr.attendance_corrections.edit_all')) throw forbidden('Only HR files a correction for somebody else');
      employeeId = b.employeeId;
    }
    if (!employeeId) throw badRequest('Your login has no employee record — ask HR to link one');
    const employee = await prisma.employee.findUnique({ where: { id: employeeId }, select: { id: true, isActive: true } });
    if (!employee?.isActive) throw badRequest('That employee is not active');
    await checkDay(employeeId, b.date, null);
    const row = await prisma.$transaction(async (tx) => {
      const number = await nextNumber(DOC, tx);
      return tx.attendanceCorrection.create({
        data: { number, employeeId: employeeId!, date: new Date(`${b.date}T00:00:00Z`), timeIn: b.timeIn ?? null, timeOut: b.timeOut ?? null, reason: b.reason, requestedById: me.id },
      });
    });
    await audit({ entityType: DOC, entityId: row.id, action: 'CREATED', summary: `Raised ${row.number} for ${b.date}` }, req);
    res.status(201).json(await present(me, await load(me, row.id), true));
  }),
);

/** Where a filing goes — the person filing's route, or the draft's employee's — said on the form. */
attendanceCorrectionRoutes.get(
  '/route',
  requireAny(...EDIT_KEYS),
  handler(async (req, res) => {
    const me = currentUser(req);
    const id = req.query.requestId ? String(req.query.requestId) : null;
    const row = id ? await prisma.attendanceCorrection.findUnique({ where: { id }, select: { employee: { select: { userId: true } } } }) : null;
    res.json(await filingRoute(DOC, row?.employee.userId ?? me.id));
  }),
);

attendanceCorrectionRoutes.get(
  '/:id',
  // The person, their superior, an approver or HR — decided in load().
  requireAnyOrDecider(...KEYS),
  handler(async (req, res) => {
    const me = currentUser(req);
    res.json(await present(me, await load(me, req.params.id), true));
  }),
);

attendanceCorrectionRoutes.put(
  '/:id',
  requireAny(...EDIT_KEYS),
  handler(async (req, res) => {
    const me = currentUser(req);
    const row = await load(me, req.params.id);
    if (!mayChange(me, row)) throw forbidden('That is someone else’s correction');
    const b = parseBody(body, req.body);
    await checkDay(row.employeeId, b.date, row.id);
    const claimed = await prisma.attendanceCorrection.updateMany({
      where: { id: row.id, status: 'DRAFT', updatedAt: row.updatedAt },
      data: { date: new Date(`${b.date}T00:00:00Z`), timeIn: b.timeIn ?? null, timeOut: b.timeOut ?? null, reason: b.reason },
    });
    if (!claimed.count) throw badRequest('Only a draft is modified — it changed a moment ago; reload');
    await audit({ entityType: DOC, entityId: row.id, action: 'UPDATED', summary: `Modified ${row.number}` }, req);
    res.json(await present(me, await load(me, row.id), true));
  }),
);

/** Sent in the EMPLOYEE's name, whoever presses it; back to DRAFT if the engine refuses. */
attendanceCorrectionRoutes.post(
  '/:id/submit',
  requireAny(...EDIT_KEYS),
  handler(async (req, res) => {
    const me = currentUser(req);
    const row = await load(me, req.params.id);
    if (!mayChange(me, row)) throw forbidden('That is someone else’s correction');
    if (!row.employee.userId) throw badRequest(`${nameOf(row.employee)} has no login — the request goes in their name`);
    await checkDay(row.employeeId, keyOf(row.date), row.id);
    const claimed = await prisma.attendanceCorrection.updateMany({ where: { id: row.id, status: 'DRAFT', updatedAt: row.updatedAt }, data: { status: 'PENDING_APPROVAL' } });
    if (!claimed.count) throw badRequest('It was submitted or changed a moment ago — reload');
    try {
      await submitForApproval({
        documentType: DOC,
        documentId: row.id,
        documentNumber: row.number,
        subject: `${nameOf(row.employee)} — ${keyOf(row.date)}${row.timeIn ? ` in ${row.timeIn}` : ''}${row.timeOut ? ` out ${row.timeOut}` : ''}`,
        link: CORRECTION_LINK(row.id),
        requesterId: row.employee.userId,
      });
    } catch (err) {
      await prisma.attendanceCorrection.updateMany({ where: { id: row.id, status: 'PENDING_APPROVAL' }, data: { status: 'DRAFT' } });
      throw err;
    }
    await audit({ entityType: DOC, entityId: row.id, action: 'SUBMITTED', summary: `${row.number} sent for approval` }, req);
    res.json(await present(me, await load(me, row.id), true));
  }),
);

attendanceCorrectionRoutes.post(
  '/:id/withdraw',
  requireAny(...EDIT_KEYS),
  handler(async (req, res) => {
    const me = currentUser(req);
    const row = await load(me, req.params.id);
    if (!mayChange(me, row)) throw forbidden('That is someone else’s correction');
    await prisma.$transaction(async (tx) => {
      const claimed = await tx.attendanceCorrection.updateMany({ where: { id: row.id, status: 'PENDING_APPROVAL' }, data: { status: 'DRAFT' } });
      if (!claimed.count) throw badRequest('It was decided a moment ago — the decision stands');
      await cancelOpenRequest(DOC, row.id, tx, `pulled back by ${me.name}`, me.id);
    });
    await audit({ entityType: DOC, entityId: row.id, action: 'UPDATED', summary: `${row.number} pulled back to draft` }, req);
    res.json(await present(me, await load(me, row.id), true));
  }),
);

attendanceCorrectionRoutes.post(
  '/:id/cancel',
  requireAny(...EDIT_KEYS),
  handler(async (req, res) => {
    const me = currentUser(req);
    const { reason } = parseBody(z.object({ reason: z.string().trim().min(3, 'Say why').max(500) }), req.body ?? {});
    const row = await load(me, req.params.id);
    if (!mayChange(me, row)) throw forbidden('That is someone else’s correction');
    if (!['DRAFT', 'PENDING_APPROVAL'].includes(row.status)) throw badRequest(`${row.number} is ${statusLabel(row.status).toLowerCase()} — it cannot be cancelled`);
    await prisma.$transaction(async (tx) => {
      const claimed = await tx.attendanceCorrection.updateMany({ where: { id: row.id, status: row.status }, data: { status: 'CANCELLED', cancelReason: reason } });
      if (!claimed.count) throw badRequest('It moved a moment ago — reload to see where it stands');
      await cancelOpenRequest(DOC, row.id, tx, `cancelled by ${me.name}: ${reason}`, me.id);
    });
    await audit({ entityType: DOC, entityId: row.id, action: 'CANCELLED', summary: `${row.number} cancelled — ${reason}` }, req);
    res.json(await present(me, await load(me, row.id), true));
  }),
);

attendanceCorrectionRoutes.delete(
  '/:id',
  requireAny('ghr.attendance_corrections.delete'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const row = await load(me, req.params.id);
    if (!mayChange(me, row)) throw forbidden('That is someone else’s correction');
    if (!['DRAFT', 'REJECTED', 'CANCELLED'].includes(row.status)) throw badRequest('Only a draft, a rejected or a cancelled correction is deleted');
    await deleteOrRefuse(row.number, () => prisma.attendanceCorrection.delete({ where: { id: row.id } }));
    await audit({ entityType: DOC, entityId: row.id, action: 'DELETED', summary: `Deleted ${statusLabel(row.status).toLowerCase()} ${row.number}` }, req);
    res.json({ ok: true });
  }),
);

/**
 * Approval writes the times onto the day's row, in the claim's transaction:
 * the row made if the day had none, MANUAL on the side corrected, lateness,
 * hours and undertime worked out again, the correction's number and reason
 * on its note, the row as it stood kept on the request. A rejection leaves
 * the day as it is.
 */
export async function settleAttendanceCorrection(approval: ApprovalRequest, outcome: ApprovalOutcome) {
  const row = await prisma.attendanceCorrection.findUnique({ where: { id: approval.documentId } });
  if (!row) return;
  const settings = await hrSettings();
  const applied = await prisma.$transaction(async (tx) => {
    const claimed = await tx.attendanceCorrection.updateMany({
      where: { id: row.id, status: 'PENDING_APPROVAL' },
      data: outcome === 'APPROVED' ? { status: 'APPROVED', appliedAt: new Date() } : { status: 'REJECTED' },
    });
    if (!claimed.count) return null;
    if (outcome !== 'APPROVED') return 'rejected' as const;
    const day = keyOf(row.date);
    const existing = await tx.attendance.findUnique({ where: { employeeId_date: { employeeId: row.employeeId, date: row.date } } });
    const { inAt, outAt } = correctedTimes(day, row.timeIn, row.timeOut, existing?.timeIn ?? null);
    const timeIn = inAt ?? existing?.timeIn ?? null;
    const timeOut = outAt ?? existing?.timeOut ?? null;
    const note = `Corrected by ${row.number}: ${row.reason}`;
    const data = {
      timeIn,
      timeOut,
      ...(timeIn ? classifyArrival(timeIn, settings) : {}),
      workedMinutes: timeIn && timeOut ? workedMinutes(timeIn, timeOut, settings) : 0,
      undertimeMinutes: timeOut ? undertimeMinutes(timeOut, day, settings) : 0,
      timeInMethod: row.timeIn ? ('MANUAL' as const) : (existing?.timeInMethod ?? null),
      timeOutMethod: row.timeOut ? ('MANUAL' as const) : (existing?.timeOutMethod ?? null),
      notes: existing?.notes ? `${existing.notes}\n${note}` : note,
    };
    const written = existing
      ? await tx.attendance.update({ where: { id: existing.id }, data })
      : await tx.attendance.create({ data: { employeeId: row.employeeId, date: row.date, ...data } });
    await tx.attendanceCorrection.update({
      where: { id: row.id },
      data: { attendanceId: written.id, before: existing ? (JSON.parse(JSON.stringify(existing)) as Prisma.InputJsonValue) : Prisma.JsonNull },
    });
    return { written, existing };
  });
  if (!applied) {
    const now = await prisma.attendanceCorrection.findUnique({ where: { id: row.id }, select: { status: true } });
    await audit({ entityType: DOC, entityId: row.id, action: outcome, summary: `${row.number} ${outcome.toLowerCase()} after it was ${statusLabel(now?.status ?? row.status).toLowerCase()} — not applied` });
    return;
  }
  if (applied === 'rejected') {
    await audit({ entityType: DOC, entityId: row.id, action: 'REJECTED', summary: `${row.number} rejected — the day is as it was` });
    return;
  }
  await audit({ entityType: DOC, entityId: row.id, action: 'APPROVED', summary: `${row.number} approved — ${keyOf(row.date)} corrected` });
  await audit({
    entityType: 'attendance',
    entityId: applied.written.id,
    action: applied.existing ? 'UPDATED' : 'CREATED',
    summary: `Attendance for ${keyOf(row.date)} corrected by ${row.number}`,
    before: applied.existing,
    after: applied.written,
  });
}
onApprovalSettled(DOC, settleAttendanceCorrection);

/** An approved correction pulled back puts the day's row back as it stood, then the request to draft. */
onApprovalReopened(DOC, {
  may: async (actor, id) => {
    const row = await prisma.attendanceCorrection.findUnique({ where: { id }, include });
    return !!row && mayChange(actor, row);
  },
  reopen: async ({ documentId, tx }) => {
    const row = await tx.attendanceCorrection.findUnique({ where: { id: documentId } });
    if (!row) throw notFound('Attendance correction not found');
    if (row.status !== 'APPROVED') throw badRequest(`${row.number} is ${statusLabel(row.status).toLowerCase()} — only an approved correction goes back to draft`);
    if (row.attendanceId) {
      const before = row.before as Record<string, unknown> | null;
      if (before) {
        const date = (v: unknown) => (v ? new Date(String(v)) : null);
        await tx.attendance.update({
          where: { id: row.attendanceId },
          data: {
            timeIn: date(before.timeIn),
            timeOut: date(before.timeOut),
            status: before.status as Prisma.AttendanceUpdateInput['status'],
            lateMinutes: Number(before.lateMinutes ?? 0),
            workedMinutes: Number(before.workedMinutes ?? 0),
            undertimeMinutes: Number(before.undertimeMinutes ?? 0),
            timeInMethod: (before.timeInMethod ?? null) as Prisma.AttendanceUpdateInput['timeInMethod'],
            timeOutMethod: (before.timeOutMethod ?? null) as Prisma.AttendanceUpdateInput['timeOutMethod'],
            notes: (before.notes ?? null) as string | null,
          },
        });
      } else {
        await tx.attendance.delete({ where: { id: row.attendanceId } });
      }
    }
    const claimed = await tx.attendanceCorrection.updateMany({
      where: { id: row.id, status: 'APPROVED' },
      data: { status: 'DRAFT', appliedAt: null, attendanceId: null, before: Prisma.JsonNull },
    });
    if (!claimed.count) throw badRequest('It changed a moment ago — reload to see where it stands');
  },
});
