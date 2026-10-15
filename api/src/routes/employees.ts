import { Router } from 'express';
import { z } from 'zod';
import { Prisma, EmploymentType } from '@prisma/client';
import { prisma } from '../prisma';
import {
  handler,
  parseBody,
  listQuery,
  listResult,
  orderBy,
  idsFilter,
  notFound,
  conflict,
  badRequest,
  forbidden,
  type ListQuery,
} from '../http/kit';
import { authenticate, require_, requireAny, currentUser } from '../auth/middleware';
import { audit } from '../shared/audit';
import { deletePhotoIfUnused, dropAccountPhotoFromSamples } from '../shared/faceSamples';
import { deleteAttachment } from '../shared/attachments';
import { nextNumber } from '../shared/numbering';
import { can } from '../permissions/resolve';
import { positionFields, setEmployeePosition } from '../shared/plantilla';
import { sweepSeparations } from '../shared/clearance';
import { createLogin, defaultRoleIds, deliverLink } from '../shared/accounts';
import { celebrationsBetween } from '../shared/celebrations';
import { renderDocument, formatShortDate, statusLabel } from '../shared/pdf';
import { LIST_CAP, choice, listReference, sendListPdf } from '../shared/listPaper';

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

/**
 * The employee list's where-builder — the register's rows and its printed
 * twin read the same set; `?ids=` narrows to the rows ticked.
 */
function employeeListWhere(q: ListQuery): Prisma.EmployeeWhereInput {
  const where: Prisma.EmployeeWhereInput = {};
  if (q.search) {
    where.OR = [
      { firstName: { contains: q.search, mode: 'insensitive' } },
      { lastName: { contains: q.search, mode: 'insensitive' } },
      { employeeNo: { contains: q.search, mode: 'insensitive' } },
      { position: { contains: q.search, mode: 'insensitive' } },
    ];
  }
  const f = q.filters;
  if (f.isActive) where.isActive = f.isActive === 'true';
  if (f.departmentId) where.departmentId = f.departmentId;
  // The team: an industry id, or `none` for nobody assigned yet.
  if (f.industryId === 'none') where.industryId = null;
  else if (f.industryId) where.industryId = f.industryId;
  // Checked against the enum's values: an unknown type ('toString' included)
  // is a 400 naming the choices, never a 500 from the database.
  const employmentType = choice(f.employmentType, EmploymentType, 'Employment type');
  if (employmentType) where.employmentType = employmentType;
  // `none` = unclassified: an active employee with no plantilla position.
  if (f.positionId === 'none') where.positionId = null;
  else if (f.positionId) where.positionId = f.positionId;
  const ids = idsFilter(f.ids);
  if (ids) where.id = { in: ids };
  return where;
}

const EMPLOYEE_SORTS = ['employeeNo', 'lastName', 'dateHired', 'createdAt'];

employeeRoutes.get(
  '/',
  require_('ghr.employees.view_all'),
  handler(async (req, res) => {
    // Sweep-on-read: anyone past their separation date drops out here.
    await sweepSeparations();
    const me = currentUser(req);
    const seeRates = can(me, 'ghr.employee_rates.view_all');
    const q = listQuery(req);
    const where = employeeListWhere(q);

    const [rows, total] = await Promise.all([
      prisma.employee.findMany({
        where,
        include: {
          department: { select: { id: true, name: true } },
          positionRef: { select: { id: true, code: true, title: true } },
          industry: { select: { id: true, code: true, name: true } },
          user: { select: { id: true, email: true, isActive: true, invitePending: true } },
        },
        orderBy: orderBy(q, EMPLOYEE_SORTS, {
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
 * The employee register on paper — the list as filtered (or the rows
 * ticked), through `employeeListWhere`, so the paper is the screen it was
 * printed off. NEVER the pay data, whoever prints it: the select names the
 * columns it prints and nothing else, so a daily rate, a burden or a
 * statutory number cannot reach the page even for a holder of
 * `ghr.employee_rates.view_all` — a printed list travels further than a
 * screen. Declared above `/:id`, or that route swallows it.
 */
employeeRoutes.get(
  '/pdf',
  require_('ghr.employees.view_all'),
  handler(async (req, res) => {
    await sweepSeparations();
    const q = listQuery(req);
    const where = employeeListWhere(q);
    const f = q.filters;
    const [rows, count, department, team, position] = await Promise.all([
      prisma.employee.findMany({
        where,
        select: {
          employeeNo: true,
          firstName: true,
          middleName: true,
          lastName: true,
          position: true,
          positionId: true,
          employmentType: true,
          dateHired: true,
          isActive: true,
          department: { select: { name: true } },
          positionRef: { select: { title: true } },
          industry: { select: { code: true, name: true } },
          user: { select: { email: true, invitePending: true } },
        },
        orderBy: orderBy(q, EMPLOYEE_SORTS, { lastName: 'asc' }),
        take: LIST_CAP,
      }),
      prisma.employee.count({ where }),
      f.departmentId ? prisma.department.findUnique({ where: { id: f.departmentId }, select: { name: true } }) : null,
      f.industryId && f.industryId !== 'none'
        ? prisma.industry.findUnique({ where: { id: f.industryId }, select: { name: true } })
        : null,
      f.positionId && f.positionId !== 'none'
        ? prisma.position.findUnique({ where: { id: f.positionId }, select: { title: true } })
        : null,
    ]);

    const reference = listReference(count, rows.length, ['employee', 'employees'], [
      q.search && `search "${q.search}"`,
      f.isActive && (f.isActive === 'true' ? 'active' : 'inactive'),
      f.departmentId && `department ${department?.name ?? 'not found'}`,
      f.industryId && (f.industryId === 'none' ? 'no team yet' : `team ${team?.name ?? 'not found'}`),
      f.employmentType && `type ${statusLabel(f.employmentType)}`,
      f.positionId && (f.positionId === 'none' ? 'no plantilla position' : `position ${position?.title ?? 'not found'}`),
      f.ids && 'the rows selected',
    ]);

    // Eight columns: landscape (rule 6).
    const pdf = await renderDocument({
      title: 'Employees',
      date: new Date(),
      reference,
      landscape: true,
      sections: [
        {
          kind: 'table',
          head: ['Number', 'Name', 'Department', 'Team', 'Type', 'Hired', 'Login', 'Status'],
          rows: rows.map((e) => {
            const initial = e.middleName?.trim()?.[0];
            const post = e.positionRef?.title ?? e.position;
            return [
              e.employeeNo,
              {
                title: `${e.lastName}, ${e.firstName}${initial ? ` ${initial}.` : ''}`,
                body: post ? `${post}${!e.positionId ? ' · unclassified' : ''}` : undefined,
              },
              e.department?.name ?? '—',
              e.industry?.code ?? '—',
              statusLabel(e.employmentType),
              e.dateHired ? formatShortDate(e.dateHired) : '—',
              e.user ? { title: e.user.email, body: e.user.invitePending ? 'Invited' : undefined } : 'None',
              e.isActive ? 'Active' : 'Inactive',
            ];
          }),
        },
      ],
    });
    await audit(
      { entityType: 'employee', entityId: 'list', action: 'EXPORTED', summary: `Exported the employee list as PDF (${rows.length} employee(s))` },
      req,
    );
    sendListPdf(res, pdf, 'employees.pdf');
  }),
);

/**
 * Birthdays and work anniversaries in a window of days (2026-10-08): the
 * sales calendar's People layer and My Work read it. For anyone signed in —
 * the owner's call: a colleague's birthday, age and years with the company
 * are the office's to know — names, days and years only, nothing else off
 * the record. Above `/:id`, like `/lookup`.
 */
const DAY_KEY = /^\d{4}-\d{2}-\d{2}$/;
employeeRoutes.get(
  '/celebrations',
  handler(async (req, res) => {
    const from = String(req.query.from ?? '');
    const to = String(req.query.to ?? from);
    const isDay = (v: string) => DAY_KEY.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`)) && new Date(`${v}T00:00:00Z`).toISOString().startsWith(v);
    if (!isDay(from) || !isDay(to)) throw badRequest('from and to are days written YYYY-MM-DD');
    if (to < from) throw badRequest('from is after to');
    const span = (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000;
    if (span > 366) throw badRequest('At most a year at a time');
    res.json({ from, to, celebrations: await celebrationsBetween(from, to) });
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
    // Admin › Users' "an employee already on the register" branch is offered
    // on edit_all (2026-10-10), and whoever may change every employee may
    // surely list them — without this the branch could name nobody.
    'ghr.employees.edit_all',
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
        positionRef: { select: { id: true, code: true, title: true } },
        industry: { select: { id: true, code: true, name: true } },
        user: {
          select: {
            id: true,
            email: true,
            isActive: true,
            invitePending: true,
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
  /** The industry team (Utilities, Healthcare…) — an Industry row. */
  industryId: z.string().optional().nullable(),
  position: z.string().trim().optional().nullable(),
  /** The plantilla slot; when set, `position` mirrors its title (shared/plantilla.ts). */
  positionId: z.string().optional().nullable(),
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

/**
 * The G-CORE login made with the employee — "one creation": HR saves the
 * person and their sign-in together, and the invitation goes out. Making a
 * login is the administrator's right (admin.users.create), so a form without
 * it saves the person and leaves the login to an administrator.
 */
const loginSchema = z.object({
  email: z.string().trim().email('Enter the email they will sign in with'),
  /** Defaults to the self-service Employee role. */
  roleIds: z.array(z.string()).optional(),
  supervisorId: z.string().optional().nullable(),
  /** Set a password now instead of inviting them to choose one. */
  password: z.string().min(8, 'Use at least 8 characters').max(128, 'Use at most 128 characters').optional().nullable(),
});

const createEmployeeSchema = employeeSchema.extend({ login: loginSchema.optional().nullable() });

const fullName = (e: { firstName: string; lastName: string; suffix?: string | null }) =>
  [e.firstName, e.lastName, e.suffix].filter(Boolean).join(' ');

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

/**
 * A team is an Industry row that exists and is in use. One already on the
 * record may stay after it is deactivated — the PATCH only checks a change.
 */
async function teamId(tx: Prisma.TransactionClient, id: string | null | undefined): Promise<string | null> {
  if (!id) return null;
  const industry = await tx.industry.findUnique({ where: { id }, select: { isActive: true } });
  if (!industry) throw badRequest('That team (industry) does not exist', [{ field: 'industryId', message: 'Choose a team from the list' }]);
  if (!industry.isActive) throw badRequest('That team (industry) is switched off', [{ field: 'industryId', message: 'Choose an active team' }]);
  return id;
}

/**
 * The roles a new login starts with, each checked to exist — a 400 naming
 * the unknown one, where the foreign key used to answer with a 500 after the
 * employee was already written. `field` is the path the REQUEST has: the
 * login is nested on `POST /employees` and the whole body on `/:id/login`,
 * and an error box that highlights by field must find the right box.
 */
async function checkRoleIds(
  tx: Prisma.TransactionClient,
  roleIds: string[] | undefined,
  field: 'login.roleIds' | 'roleIds',
): Promise<string[]> {
  const ids = [...new Set(roleIds ?? [])];
  if (!ids.length) return defaultRoleIds(tx);
  const found = await tx.role.findMany({ where: { id: { in: ids } }, select: { id: true } });
  const known = new Set(found.map((r) => r.id));
  const unknown = ids.filter((id) => !known.has(id));
  if (unknown.length) {
    throw badRequest(`Unknown role${unknown.length > 1 ? 's' : ''}: ${unknown.join(', ')}`, [
      { field, message: 'Choose roles from the list' },
    ]);
  }
  return ids;
}

/**
 * The same rule for the two other references a creation carries (2026-10-10):
 * an unknown "Reports to" or department is a 400 naming the field, checked
 * before the person is written, where the foreign key answered 500. The web
 * cannot send one (PersonSelect, the department select), but a script can.
 */
async function checkSupervisorId(
  tx: Prisma.TransactionClient,
  id: string | null | undefined,
  field: 'login.supervisorId' | 'supervisorId',
): Promise<string | null> {
  if (!id) return null;
  if (!(await tx.user.findUnique({ where: { id }, select: { id: true } }))) {
    throw badRequest('That "Reports to" login does not exist', [{ field, message: 'Choose someone from the list' }]);
  }
  return id;
}

async function checkDepartmentId(tx: Prisma.TransactionClient, id: string | null | undefined): Promise<string | null> {
  if (!id) return null;
  if (!(await tx.department.findUnique({ where: { id }, select: { id: true } }))) {
    throw badRequest('That department does not exist', [{ field: 'departmentId', message: 'Choose a department from the list' }]);
  }
  return id;
}

/**
 * The login mirrors its employee's number (`User.employeeNo` — the `{EMP}`
 * in their quotation numbers, and what the face clock reads). The column is
 * unique on User too, so a number an older login still carries is left on
 * that login and this one goes without, rather than the save failing.
 */
async function mirrorEmployeeNo(tx: Prisma.TransactionClient, employeeNo: string): Promise<string | null> {
  const taken = await tx.user.findUnique({ where: { employeeNo }, select: { id: true } });
  return taken ? null : employeeNo;
}

employeeRoutes.post(
  '/',
  require_('ghr.employees.create'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const body = parseBody(createEmployeeSchema, req.body);
    const maySetRates = can(me, 'ghr.employee_rates.edit_all');
    // Refused before anything is written: no half-made person without their login.
    if (body.login && !can(me, 'admin.users.create')) {
      throw forbidden('Creating a G-CORE login needs admin.users.create — save the employee, and an administrator can invite them from their record');
    }
    if (body.login && body.userId) throw badRequest('Link an existing login or create a new one — not both');
    // The same rule as /:id/login: nobody signs in as someone who is not on the
    // active register. Refused before the transaction, so no employee is left.
    if (body.login && !body.isActive) {
      throw badRequest('An inactive employee cannot be given a login — save them active, or leave the login for later', [
        { field: 'isActive', message: 'Tick Active, or untick the login' },
      ]);
    }

    const { employee, login } = await prisma.$transaction(async (tx) => {
      const employeeNo = body.employeeNo || (await nextNumber('employee', tx));
      if (await tx.employee.findUnique({ where: { employeeNo } })) {
        throw conflict(`Employee number "${employeeNo}" is already in use`);
      }
      if (body.userId) {
        if (!(await tx.user.findUnique({ where: { id: body.userId }, select: { id: true } }))) {
          throw notFound('User not found');
        }
        const taken = await tx.employee.findUnique({ where: { userId: body.userId } });
        if (taken) throw conflict('That user account is already linked to another employee');
      }
      // Checked before the person is written: the login's email first.
      if (body.login) await assertLoginEmailFree(tx, body.login.email);
      const roleIds = body.login ? await checkRoleIds(tx, body.login.roleIds, 'login.roleIds') : [];
      const supervisorId = body.login ? await checkSupervisorId(tx, body.login.supervisorId, 'login.supervisorId') : null;

      const created = await tx.employee.create({
        data: {
          employeeNo,
          firstName: body.firstName,
          lastName: body.lastName,
          middleName: body.middleName || null,
          suffix: body.suffix || null,
          userId: body.userId || null,
          departmentId: await checkDepartmentId(tx, body.departmentId),
          industryId: await teamId(tx, body.industryId),
          ...(await positionFields(tx, body.positionId, body.position)),
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
      if (!body.login) return { employee: created, login: null };

      // The login, in the same transaction: a refused email leaves no person behind.
      const login = await createLogin(
        tx,
        {
          email: body.login.email,
          name: fullName(created),
          password: body.login.password,
          roleIds,
          supervisorId,
          departmentId: created.departmentId,
          position: created.position,
          phone: created.mobile,
          employeeNo: await mirrorEmployeeNo(tx, created.employeeNo),
        },
        me.id,
      );
      const linked = await tx.employee.update({ where: { id: created.id }, data: { userId: login.user.id } });
      return { employee: linked, login };
    });

    await audit(
      {
        entityType: 'employee',
        entityId: employee.id,
        action: 'CREATED',
        summary: `Created employee ${employee.employeeNo} — ${employee.firstName} ${employee.lastName}${login ? `, with the login ${login.user.email}` : ''}`,
      },
      req,
    );
    if (login) {
      await audit(
        {
          entityType: 'user',
          entityId: login.user.id,
          action: 'CREATED',
          summary: `Created user ${login.user.email} with employee ${employee.employeeNo}${login.invite ? ' — invited' : ''}`,
        },
        req,
      );
    }
    const invite = login?.invite ? await deliverLink('INVITE', login.user, login.invite, me.name) : null;
    res.status(201).json({
      ...stripRates(decimalsToNumbers(employee) as typeof employee, maySetRates),
      login: login ? { user: login.user, invite } : null,
    });
  }),
);

/**
 * An email that is already somebody's login, said in words the person at the
 * form can act on (2026-10-13, the owner's report: "I can't add employee" —
 * the bare "Someone already uses that email address" named nobody and offered
 * nothing). A login with no employee record yet is LINKABLE: the 409 carries
 * it (`details[0].existingLogin`) so the form offers "Link … existing login"
 * instead of making a second account. One already on another employee's
 * record names that record — adding the person again would be a duplicate.
 * Checked before anything is written; `createLogin()` keeps its own check.
 */
async function assertLoginEmailFree(tx: Prisma.TransactionClient, rawEmail: string): Promise<void> {
  const email = rawEmail.trim().toLowerCase();
  const user = await tx.user.findUnique({
    where: { email },
    select: { id: true, name: true, email: true, isActive: true, employee: { select: { id: true, employeeNo: true, firstName: true, lastName: true } } },
  });
  if (!user) return;
  const field = 'login.email';
  if (user.employee) {
    const who = `${user.employee.employeeNo} — ${user.employee.firstName} ${user.employee.lastName}`;
    const message = `${user.email} is already the G-CORE login of ${who} on the register. Open their record instead of adding them again, or use another email.`;
    throw conflict(message, [
      { field, message, existingLogin: { id: user.id, name: user.name, email: user.email, linkable: false, employeeId: user.employee.id, employeeNo: user.employee.employeeNo } },
    ]);
  }
  const message = `${user.email} is already the G-CORE login of ${user.name}${user.isActive ? '' : ' (switched off)'}, who has no employee record yet. Link this employee to that login instead of making a new one.`;
  throw conflict(message, [{ field, message, existingLogin: { id: user.id, name: user.name, email: user.email, linkable: true, isActive: user.isActive } }]);
}

/**
 * A login for someone already on the register — the employee HR added before
 * logins could be made here, or one who never had one. Same account, same
 * invitation as making them together.
 */
employeeRoutes.post(
  '/:id/login',
  require_('ghr.employees.edit_all'),
  handler(async (req, res) => {
    const me = currentUser(req);
    if (!can(me, 'admin.users.create')) {
      throw forbidden('Creating a G-CORE login needs admin.users.create — ask an administrator');
    }
    const body = parseBody(loginSchema, req.body);

    const made = await prisma.$transaction(async (tx) => {
      // The row is LOCKED first (2026-10-10, the expense claim's rule): two of
      // these at once both read "no login" otherwise, and the loser died on
      // User.employeeNo's unique index with a 500 — or, with the number held
      // by an older login, both passed and the first login was orphaned. The
      // second waits here until the first commits, reads the link it made and
      // is refused with the 409 the sequential case gives.
      const locked = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM "Employee" WHERE id = ${req.params.id} FOR UPDATE`;
      if (!locked.length) throw notFound('Employee not found');
      const employee = await tx.employee.findUnique({ where: { id: req.params.id } });
      if (!employee) throw notFound('Employee not found');
      if (employee.userId) throw conflict(`${employee.firstName} ${employee.lastName} already has a login`);
      if (!employee.isActive) throw badRequest('This employee is inactive — reactivate them before giving them a login');
      await assertLoginEmailFree(tx, body.email);
      const login = await createLogin(
        tx,
        {
          email: body.email,
          name: fullName(employee),
          password: body.password,
          roleIds: await checkRoleIds(tx, body.roleIds, 'roleIds'),
          supervisorId: await checkSupervisorId(tx, body.supervisorId, 'supervisorId'),
          departmentId: employee.departmentId,
          position: employee.position,
          phone: employee.mobile,
          employeeNo: await mirrorEmployeeNo(tx, employee.employeeNo),
        },
        me.id,
      );
      // And the link is CLAIMED, never written over: the lock above decides
      // the race, this keeps an unconditional update from ever orphaning a
      // login should the lock be lost in a refactor.
      const claimed = await tx.employee.updateMany({ where: { id: employee.id, userId: null }, data: { userId: login.user.id } });
      if (claimed.count !== 1) throw conflict(`${employee.firstName} ${employee.lastName} already has a login`);
      return { employee, login };
    });

    await audit(
      {
        entityType: 'user',
        entityId: made.login.user.id,
        action: 'CREATED',
        summary: `Created user ${made.login.user.email} for employee ${made.employee.employeeNo}${made.login.invite ? ' — invited' : ''}`,
      },
      req,
    );
    // The register's own history says the person got their login (2026-10-10).
    await audit(
      {
        entityType: 'employee',
        entityId: made.employee.id,
        action: 'UPDATED',
        summary: `Linked the login ${made.login.user.email}`,
        after: { userId: made.login.user.id },
      },
      req,
    );
    const invite = made.login.invite ? await deliverLink('INVITE', made.login.user, made.login.invite, me.name) : null;
    res.status(201).json({ user: made.login.user, invite });
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
    if (body.departmentId !== undefined) data.departmentId = await checkDepartmentId(prisma, body.departmentId);
    if (body.industryId !== undefined && body.industryId !== before.industryId) {
      data.industryId = await teamId(prisma, body.industryId);
    }
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

    const employee = await prisma.$transaction(async (tx) => {
      const updated = await tx.employee.update({ where: { id: req.params.id }, data });
      // The position goes through the one writer of the mirror. A free-text
      // title on an employee who holds a plantilla position is ignored: the
      // title belongs to the position, and is changed there.
      if (body.positionId !== undefined) {
        return setEmployeePosition(tx, updated.id, body.positionId || null, body.position ?? before.position);
      }
      if (body.position !== undefined && !before.positionId) {
        return setEmployeePosition(tx, updated.id, null, body.position);
      }
      return updated;
    });
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

    // The face samples go with the person (the rows cascade), and so do their
    // photos and any clock capture filed under them: a face is not kept for a
    // record that no longer exists — nor the account picture cut from one.
    const samples = await prisma.faceEnrollment.findMany({ where: { employeeId: employee.id }, select: { id: true } });
    await prisma.employee.delete({ where: { id: req.params.id } });
    await dropAccountPhotoFromSamples(
      employee.userId,
      samples.map((s) => s.id),
    );
    const faces = await prisma.attachment.findMany({
      where: { entityType: { in: ['face_enrollment', 'attendance'] }, entityId: employee.id },
      select: { id: true },
    });
    for (const f of faces) await deletePhotoIfUnused(f.id);
    // Their People Flow rows cascade; the files filed on those items go too.
    const flowFiles = await prisma.attachment.findMany({
      where: { entityType: 'employee_flow_item', entityId: { startsWith: `${employee.id}~` } },
      select: { id: true },
    });
    for (const f of flowFiles) await deleteAttachment(f.id);
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
