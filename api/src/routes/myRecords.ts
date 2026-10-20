import { Router } from 'express';
import { prisma } from '../prisma';
import { handler, badRequest } from '../http/kit';
import { authenticate, requireAny, currentUser } from '../auth/middleware';
import { manilaDayKey } from '../shared/day';
import { holidays } from '../shared/holidays';
import { hrSettings, leaveBalance } from '../shared/hr';
import { openSteps } from '../shared/approvals';
import { statusLabel } from '../shared/pdf';
import {
  cutoffFor,
  cutoffByKey,
  shiftCutoff,
  daysOf,
  dtrDay,
  serviceLength,
  taxStatusLabel,
  type CutoffRule,
  type DtrDay,
} from '../shared/records';

/**
 * G-HR › MY RECORDS (2026-10-20, the owner's G-HR Records spec): the signed-in
 * employee's own records on one page — the cutoff's daily time record, leave
 * balances, their overtime, the 201 file and their place on the Plantilla.
 * Nothing new is stored but the tax status: every figure is read off the
 * attendance, leave, overtime and employee records the other screens keep.
 * Only ever the caller's own — there is no `employeeId` to ask for, so the
 * statutory numbers on the 201 file (shown to the person, hidden from
 * colleagues) cannot be asked for anyone else.
 */
export const myRecordsRoutes = Router();
myRecordsRoutes.use(authenticate);

const day = (d: Date | null | undefined) => (d ? d.toISOString().slice(0, 10) : null);

myRecordsRoutes.get(
  '/',
  requireAny('ghr.my_records.view_own'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const settings = await hrSettings();
    const rule: CutoffRule = { mode: settings.cutoffMode, firstEnds: settings.cutoffFirstEnds };
    const now = new Date();
    const today = manilaDayKey(now);
    const current = cutoffFor(today, rule);
    const asked = typeof req.query.cutoff === 'string' && req.query.cutoff ? req.query.cutoff : null;
    const cutoff = asked ? cutoffByKey(asked, rule) : current;
    if (!cutoff) throw badRequest(`"${asked}" is not a cutoff — use 2026-10-A, 2026-10-B or 2026-10`);

    const employee = await prisma.employee.findUnique({
      where: { userId: me.id },
      include: {
        industry: { select: { code: true, name: true } },
        positionRef: { select: { code: true, title: true, role: { select: { name: true, rank: true } } } },
        extraPositions: { select: { position: { select: { code: true, title: true } } } },
      },
    });
    const prev = shiftCutoff(cutoff, -1, rule);
    const next = cutoff.key === current.key ? null : shiftCutoff(cutoff, 1, rule);
    const period = { ...cutoff, current: cutoff.key === current.key, previous: prev.key, next: next?.key ?? null, mode: rule.mode };
    if (!employee) {
      res.json({ employee: null, cutoff: period });
      return;
    }

    const from = new Date(`${cutoff.from}T00:00:00Z`);
    const to = new Date(`${cutoff.to}T00:00:00Z`);
    const year = Number(today.slice(0, 4));
    const [punches, leaves, holidayList, types, overtime, login] = await Promise.all([
      prisma.attendance.findMany({ where: { employeeId: employee.id, date: { gte: from, lte: to } } }),
      prisma.leaveRequest.findMany({
        where: { employeeId: employee.id, status: 'APPROVED', startDate: { lte: to }, endDate: { gte: from } },
        select: { startDate: true, endDate: true, leaveType: { select: { name: true } } },
      }),
      holidays(),
      prisma.leaveType.findMany({ where: { isActive: true }, orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }] }),
      prisma.overtimeRequest.findMany({
        where: { employeeId: employee.id, date: { gte: from, lte: to } },
        orderBy: { date: 'desc' },
        include: { job: { select: { number: true, name: true } } },
      }),
      prisma.user.findUnique({
        where: { id: me.id },
        select: {
          supervisor: { select: { name: true, position: true } },
          roles: { select: { role: { select: { name: true, rank: true } } } },
          _count: { select: { reports: { where: { isActive: true } } } },
        },
      }),
    ]);

    // ── The daily time record ──
    const byDay = new Map(punches.map((p) => [day(p.date)!, p]));
    const holidayByDay = new Map(holidayList.map((h) => [h.date, h.name]));
    const leaveByDay = new Map<string, string>();
    for (const l of leaves) {
      for (const k of daysOf(day(l.startDate)!, day(l.endDate)!)) leaveByDay.set(k, l.leaveType.name);
    }
    const days: DtrDay[] = daysOf(cutoff.from, cutoff.to).map((date) =>
      dtrDay({ date, today, now, punch: byDay.get(date) ?? null, holiday: holidayByDay.get(date) ?? null, leave: leaveByDay.get(date) ?? null, hired: day(employee.dateHired) }),
    );
    const totals = {
      present: days.filter((d) => ['PRESENT', 'LATE', 'HALF_DAY', 'OPEN'].includes(d.status)).length,
      late: days.filter((d) => d.lateMinutes > 0).length,
      lateMinutes: days.reduce((t, d) => t + d.lateMinutes, 0),
      undertimeMinutes: days.reduce((t, d) => t + d.undertimeMinutes, 0),
      workedMinutes: days.reduce((t, d) => t + d.workedMinutes, 0),
      absent: days.filter((d) => d.status === 'ABSENT').length,
      onLeave: days.filter((d) => d.status === 'ON_LEAVE').length,
    };

    // ── Leave balances, this year ──
    const balances = await Promise.all(
      types.map(async (t) => ({ leaveType: { id: t.id, code: t.code, name: t.name, isPaid: t.isPaid }, ...(await leaveBalance(employee.id, t.id, year)) })),
    );

    // ── Overtime in the cutoff, with who decides or decided ──
    const ids = overtime.map((o) => o.id);
    const [priorSteps, actualSteps, decided] = await Promise.all([
      openSteps('overtime_prior', ids),
      openSteps('overtime_request', ids),
      prisma.approvalRequest.findMany({
        where: { documentType: { in: ['overtime_prior', 'overtime_request'] }, documentId: { in: ids }, status: { not: 'PENDING' } },
        orderBy: { createdAt: 'desc' },
        select: {
          documentId: true,
          actions: {
            where: { selfSigned: false, action: { in: ['APPROVED', 'REJECTED', 'RETURNED'] } },
            orderBy: { actedAt: 'desc' },
            take: 1,
            select: { approver: { select: { name: true } } },
          },
        },
      }),
    ]);
    const lastSigner = new Map<string, string>();
    for (const r of decided) {
      const name = r.actions[0]?.approver.name;
      if (name && !lastSigner.has(r.documentId)) lastSigner.set(r.documentId, name);
    }
    const overtimeRows = overtime.map((o) => {
      const step = actualSteps.get(o.id) ?? priorSteps.get(o.id);
      return {
        id: o.id,
        number: o.number,
        date: day(o.date),
        hours: Number(o.actualHours ?? o.estimatedHours),
        actual: o.actualHours != null,
        window: `${o.actualStart ?? o.plannedStart}–${o.actualEnd ?? o.plannedEnd}`,
        reason: o.reason,
        project: o.job ? `${o.job.number} — ${o.job.name}` : null,
        stage: o.stage,
        stageLabel: statusLabel(o.stage),
        approver: step ? `Waiting — ${step}` : (lastSigner.get(o.id) ?? null),
      };
    });

    // ── The 201 file ──
    const hired = day(employee.dateHired);
    const service = hired ? serviceLength(hired, today) : null;
    const roles = (login?.roles ?? []).map((r) => r.role).sort((a, b) => (a.rank ?? 99) - (b.rank ?? 99));

    res.json({
      cutoff: period,
      dtr: { days, totals, today },
      balances,
      year,
      overtime: overtimeRows,
      file: {
        employeeNo: employee.employeeNo,
        name: [employee.firstName, employee.middleName, employee.lastName, employee.suffix].filter(Boolean).join(' '),
        title: employee.position,
        team: employee.industry,
        employmentType: employee.employmentType,
        employmentTypeLabel: statusLabel(employee.employmentType),
        dateHired: hired,
        dateRegularized: day(employee.dateRegularized),
        service,
        sssNo: employee.sssNo,
        pagibigNo: employee.pagibigNo,
        philhealthNo: employee.philhealthNo,
        tin: employee.tin,
        taxStatus: employee.taxStatus,
        taxStatusLabel: taxStatusLabel(employee.taxStatus),
        emergencyContactName: employee.emergencyContactName,
        emergencyContactPhone: employee.emergencyContactPhone,
        mobile: employee.mobile,
        address: employee.address,
        birthDate: day(employee.birthDate),
      },
      plantilla: {
        title: employee.position,
        position: employee.positionRef ? { code: employee.positionRef.code, title: employee.positionRef.title, role: employee.positionRef.role?.name ?? null } : null,
        alsoHolds: employee.extraPositions.map((x) => x.position),
        roles: roles.map((r) => ({ name: r.name, rank: r.rank })),
        team: employee.industry,
        reportsTo: login?.supervisor ?? null,
        directReports: login?._count.reports ?? 0,
      },
    });
  }),
);
