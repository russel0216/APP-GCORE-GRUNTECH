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
  notFound,
  conflict,
  badRequest,
} from '../http/kit';
import { authenticate, require_, requireAny, currentUser } from '../auth/middleware';
import { audit } from '../shared/audit';
import { nextNumber } from '../shared/numbering';
import { can } from '../permissions/resolve';

// ════════════════════════════════════════════════════════════════════
//  EMPLOYEES
// ════════════════════════════════════════════════════════════════════

export const employeeRoutes = Router();
employeeRoutes.use(authenticate);

/**
 * Pay data is stripped unless the caller holds ghr.employee_rates.view_all.
 *
 * Done on the way OUT of the API rather than by hiding fields in the UI — a
 * project manager listing employees must not receive salaries in the JSON and
 * simply not see them rendered.
 */
const RATE_FIELDS = [
  'dailyRate',
  'burdenMultiplier',
  'sssNo',
  'philhealthNo',
  'pagibigNo',
  'tin',
] as const;

function stripRates<T extends Record<string, unknown>>(row: T, allowed: boolean): T {
  if (allowed) return row;
  const out = { ...row };
  for (const f of RATE_FIELDS) delete out[f];
  return out;
}

function decimalsToNumbers(row: Record<string, unknown>): Record<string, unknown> {
  const out = { ...row };
  if (out.dailyRate != null) out.dailyRate = Number(out.dailyRate);
  if (out.burdenMultiplier != null) out.burdenMultiplier = Number(out.burdenMultiplier);
  return out;
}

employeeRoutes.get(
  '/',
  require_('ghr.employees.view_all'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const seeRates = can(me, 'ghr.employee_rates.view_all');
    const q = listQuery(req);
    const where: Prisma.EmployeeWhereInput = {};

    if (q.search) {
      where.OR = [
        { firstName: { contains: q.search, mode: 'insensitive' } },
        { lastName: { contains: q.search, mode: 'insensitive' } },
        { employeeNo: { contains: q.search, mode: 'insensitive' } },
        { position: { contains: q.search, mode: 'insensitive' } },
      ];
    }
    if (q.filters.isActive) where.isActive = q.filters.isActive === 'true';
    if (q.filters.departmentId) where.departmentId = q.filters.departmentId;
    if (q.filters.employmentType) {
      where.employmentType = q.filters.employmentType as Prisma.EnumEmploymentTypeFilter['equals'];
    }

    const [rows, total] = await Promise.all([
      prisma.employee.findMany({
        where,
        include: {
          department: { select: { id: true, name: true } },
          user: { select: { id: true, email: true, isActive: true } },
        },
        orderBy: orderBy(q, ['employeeNo', 'lastName', 'dateHired', 'createdAt'], {
          lastName: 'asc',
        }),
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
      }),
      prisma.employee.count({ where }),
    ]);

    res.json(
      listResult(
        rows.map((r) => stripRates(decimalsToNumbers(r) as typeof r, seeRates)),
        total,
        q,
      ),
    );
  }),
);

/**
 * Naming a colleague — as a trainee, an evaluation subject or a leaver — is not
 * the same right as reading the employee register, so the pickers on those
 * screens come here rather than to the list. Names and posts only: no pay
 * data, no user id. Must sit above `/:id` or that route swallows it.
 */
employeeRoutes.get(
  '/lookup',
  requireAny(
    'ghr.employees.view_all',
    'ghr.training_sessions.create',
    'ghr.training_sessions.edit_all',
    'ghr.evaluations.create',
    'ghr.clearances.create',
  ),
  handler(async (req, res) => {
    const term = String(req.query.q ?? '').trim();
    const where: Prisma.EmployeeWhereInput = {};
    if (req.query.active === 'true') where.isActive = true;
    if (req.query.active === 'false') where.isActive = false;
    if (term) {
      where.OR = [
        { firstName: { contains: term, mode: 'insensitive' } },
        { lastName: { contains: term, mode: 'insensitive' } },
        { employeeNo: { contains: term, mode: 'insensitive' } },
      ];
    }

    const rows = await prisma.employee.findMany({
      where,
      select: {
        id: true,
        employeeNo: true,
        firstName: true,
        lastName: true,
        position: true,
        employmentType: true,
        userId: true,
        department: { select: { id: true, name: true } },
      },
      orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }],
      take: 50,
    });

    res.json(
      rows.map(({ userId, ...r }) => ({ ...r, hasUser: userId != null })),
    );
  }),
);

employeeRoutes.get(
  '/:id',
  require_('ghr.employees.view_all'),
  handler(async (req, res) => {
    const seeRates = can(currentUser(req), 'ghr.employee_rates.view_all');
    const employee = await prisma.employee.findUnique({
      where: { id: req.params.id },
      include: {
        department: { select: { id: true, name: true } },
        user: {
          select: {
            id: true,
            email: true,
            isActive: true,
            supervisor: { select: { id: true, name: true } },
          },
        },
      },
    });
    if (!employee) throw notFound('Employee not found');

    res.json({
      ...stripRates(decimalsToNumbers(employee) as typeof employee, seeRates),
      canSeeRates: seeRates,
      // Filled by Phase 6.
      attendance: [],
      leaveRequests: [],
      overtimeRequests: [],
    });
  }),
);

const EMPLOYMENT_TYPES = [
  'REGULAR',
  'PROBATIONARY',
  'PROJECT_BASED',
  'CONTRACTUAL',
  'PART_TIME',
  'TRAINEE',
] as const;

const employeeSchema = z.object({
  employeeNo: z.string().trim().optional(),
  firstName: z.string().trim().min(1, 'First name is required'),
  lastName: z.string().trim().min(1, 'Last name is required'),
  middleName: z.string().trim().optional().nullable(),
  suffix: z.string().trim().optional().nullable(),
  userId: z.string().optional().nullable(),
  departmentId: z.string().optional().nullable(),
  position: z.string().trim().optional().nullable(),
  employmentType: z.enum(EMPLOYMENT_TYPES).default('REGULAR'),
  dateHired: z.string().optional().nullable(),
  dateRegularized: z.string().optional().nullable(),
  dateSeparated: z.string().optional().nullable(),
  // End of the current probationary or training period.
  periodEndDate: z.string().optional().nullable(),
  mobile: z.string().trim().optional().nullable(),
  personalEmail: z.string().trim().email('Enter a valid email').optional().nullable().or(z.literal('')),
  address: z.string().trim().optional().nullable(),
  birthDate: z.string().optional().nullable(),
  emergencyContactName: z.string().trim().optional().nullable(),
  emergencyContactPhone: z.string().trim().optional().nullable(),
  dailyRate: z.number().nonnegative().optional().nullable(),
  burdenMultiplier: z.number().min(1, 'A burden multiplier is at least 1.0').max(5).optional().nullable(),
  sssNo: z.string().trim().optional().nullable(),
  philhealthNo: z.string().trim().optional().nullable(),
  pagibigNo: z.string().trim().optional().nullable(),
  tin: z.string().trim().optional().nullable(),
  isActive: z.boolean().default(true),
  notes: z.string().optional().nullable(),
});

function asDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) throw badRequest(`"${value}" is not a valid date`);
  return d;
}

/** Rate fields are only accepted from someone allowed to set them. */
function rateData(
  body: z.infer<typeof employeeSchema> | Partial<z.infer<typeof employeeSchema>>,
  allowed: boolean,
) {
  if (!allowed) return {};
  const out: Record<string, unknown> = {};
  if (body.dailyRate !== undefined) {
    out.dailyRate = body.dailyRate != null ? new Prisma.Decimal(body.dailyRate) : null;
  }
  if (body.burdenMultiplier !== undefined) {
    out.burdenMultiplier =
      body.burdenMultiplier != null ? new Prisma.Decimal(body.burdenMultiplier) : null;
  }
  for (const f of ['sssNo', 'philhealthNo', 'pagibigNo', 'tin'] as const) {
    if (body[f] !== undefined) out[f] = body[f] || null;
  }
  return out;
}

employeeRoutes.post(
  '/',
  require_('ghr.employees.create'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const body = parseBody(employeeSchema, req.body);
    const maySetRates = can(me, 'ghr.employee_rates.edit_all');

    const employee = await prisma.$transaction(async (tx) => {
      const employeeNo = body.employeeNo || (await nextNumber('employee', tx));
      if (await tx.employee.findUnique({ where: { employeeNo } })) {
        throw conflict(`Employee number "${employeeNo}" is already in use`);
      }
      if (body.userId) {
        const taken = await tx.employee.findUnique({ where: { userId: body.userId } });
        if (taken) throw conflict('That user account is already linked to another employee');
      }

      return tx.employee.create({
        data: {
          employeeNo,
          firstName: body.firstName,
          lastName: body.lastName,
          middleName: body.middleName || null,
          suffix: body.suffix || null,
          userId: body.userId || null,
          departmentId: body.departmentId || null,
          position: body.position || null,
          employmentType: body.employmentType,
          dateHired: asDate(body.dateHired),
          dateRegularized: asDate(body.dateRegularized),
          dateSeparated: asDate(body.dateSeparated),
          periodEndDate: asDate(body.periodEndDate),
          mobile: body.mobile || null,
          personalEmail: body.personalEmail || null,
          address: body.address || null,
          birthDate: asDate(body.birthDate),
          emergencyContactName: body.emergencyContactName || null,
          emergencyContactPhone: body.emergencyContactPhone || null,
          isActive: body.isActive,
          notes: body.notes || null,
          ...rateData(body, maySetRates),
        },
      });
    });

    await audit(
      {
        entityType: 'employee',
        entityId: employee.id,
        action: 'CREATED',
        summary: `Created employee ${employee.employeeNo} — ${employee.firstName} ${employee.lastName}`,
      },
      req,
    );
    res.status(201).json(stripRates(decimalsToNumbers(employee) as typeof employee, maySetRates));
  }),
);

employeeRoutes.patch(
  '/:id',
  require_('ghr.employees.edit_all'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const body = parseBody(employeeSchema.partial(), req.body);
    const maySetRates = can(me, 'ghr.employee_rates.edit_all');

    const before = await prisma.employee.findUnique({ where: { id: req.params.id } });
    if (!before) throw notFound('Employee not found');

    if (body.employeeNo && body.employeeNo !== before.employeeNo) {
      if (await prisma.employee.findUnique({ where: { employeeNo: body.employeeNo } })) {
        throw conflict(`Employee number "${body.employeeNo}" is already in use`);
      }
    }
    if (body.userId) {
      const taken = await prisma.employee.findUnique({ where: { userId: body.userId } });
      if (taken && taken.id !== req.params.id) {
        throw conflict('That user account is already linked to another employee');
      }
    }

    const data: Record<string, unknown> = { ...rateData(body, maySetRates) };
    for (const f of [
      'employeeNo',
      'firstName',
      'lastName',
      'middleName',
      'suffix',
      'position',
      'mobile',
      'personalEmail',
      'address',
      'emergencyContactName',
      'emergencyContactPhone',
      'notes',
    ] as const) {
      if (body[f] !== undefined) data[f] = body[f] || null;
    }
    if (body.userId !== undefined) data.userId = body.userId || null;
    if (body.departmentId !== undefined) data.departmentId = body.departmentId || null;
    if (body.employmentType !== undefined) data.employmentType = body.employmentType;
    if (body.isActive !== undefined) data.isActive = body.isActive;
    for (const f of [
      'dateHired',
      'dateRegularized',
      'dateSeparated',
      'periodEndDate',
      'birthDate',
    ] as const) {
      if (body[f] !== undefined) data[f] = asDate(body[f]);
    }

    const employee = await prisma.employee.update({ where: { id: req.params.id }, data });
    await audit(
      {
        entityType: 'employee',
        entityId: employee.id,
        action: 'UPDATED',
        summary: `Updated employee ${employee.employeeNo} — ${employee.firstName} ${employee.lastName}`,
        // `redact()` in the audit service strips costRate/salary; the explicit
        // field list here keeps the statutory numbers out too.
        before: stripRates(before as Record<string, unknown>, false),
        after: stripRates(employee as Record<string, unknown>, false),
      },
      req,
    );
    res.json(stripRates(decimalsToNumbers(employee) as typeof employee, maySetRates));
  }),
);

employeeRoutes.delete(
  '/:id',
  require_('ghr.employees.delete'),
  handler(async (req, res) => {
    const employee = await prisma.employee.findUnique({
      where: { id: req.params.id },
      include: {
        _count: {
          select: { clearances: true, evaluations: true, trainingRecords: true, attendance: true },
        },
      },
    });
    if (!employee) throw notFound('Employee not found');

    // An employee with a clearance, an evaluation, a training record or an
    // attendance row is deactivated rather than deleted — those records are
    // HR and payroll evidence, and deleting the person would orphan them.
    const held = [
      [employee._count.clearances, 'clearance(s)'],
      [employee._count.evaluations, 'evaluation(s)'],
      [employee._count.trainingRecords, 'training record(s)'],
      [employee._count.attendance, 'attendance row(s)'],
    ] as const;
    const parts = held.filter(([n]) => n > 0).map(([n, label]) => `${n} ${label}`);
    if (parts.length > 0) {
      throw conflict(
        `${employee.firstName} ${employee.lastName} has ${parts.join(', ')} — deactivate instead`,
      );
    }

    await prisma.employee.delete({ where: { id: req.params.id } });
    await audit(
      {
        entityType: 'employee',
        entityId: req.params.id,
        action: 'DELETED',
        summary: `Deleted employee ${employee.employeeNo} — ${employee.firstName} ${employee.lastName}`,
      },
      req,
    );
    res.json({ ok: true });
  }),
);
