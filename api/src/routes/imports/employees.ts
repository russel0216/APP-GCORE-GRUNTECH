import { Prisma } from '@prisma/client';
import { prisma } from '../../prisma';
import { required, optional, bool, date, oneOf, type ImportSpec } from '../../shared/csv';
import { nextNumber, setCounter } from '../../shared/numbering';
import { positionFields, setEmployeePosition } from '../../shared/plantilla';
import type { Registered } from '../imports';
import { createLogin, defaultRoleIds, deliverLink, syncLoginFromEmployee } from '../../shared/accounts';
import { can, resolveUser } from '../../permissions/resolve';
import { audit } from '../../shared/audit';

/**
 * CSV import for employees — the spec, the duplicate key and the writer,
 * registered by ../imports.ts under the `employees` entity.
 *
 * The Position column is matched to the plantilla by title. `build` only
 * RESOLVES it — `runImport` calls build on every dry run, and a dry run that
 * created positions would not be a dry run. An unknown title is created in
 * `write`, inside the row's transaction, with 0 authorised: it then shows as
 * over-complement on the Plantilla screen until HR sets the count, rather
 * than failing the row. There is no Department column (2026-10-19: the
 * department is gone; the Team column is the grouping) — one sent is ignored.
 */

const EMPLOYMENT_TYPES = [
  'REGULAR',
  'PROBATIONARY',
  'PROJECT_BASED',
  'CONTRACTUAL',
  'PART_TIME',
  'TRAINEE',
] as const;

interface EmployeeImportRecord {
  data: Prisma.EmployeeUncheckedCreateInput;
  position: { positionId: string | null; newTitle: string | null };
  /**
   * The person's login from the Email column (2026-10-16): an existing login
   * with no employee is LINKED (`linkUserId`), an address nobody uses is a new
   * invited login (`newLoginEmail`) — made in `write`, never on a dry run.
   */
  login: { linkUserId: string | null; newLoginEmail: string | null };
}

const employeeSpec: ImportSpec<EmployeeImportRecord> = {
  entity: 'employees',
  label: 'Employees',
  columns: [
    { header: 'Employee No', required: true, example: 'GTC-0001-14' },
    { header: 'Last Name', required: true, example: 'Santos' },
    { header: 'First Name', required: true, example: 'Juan' },
    { header: 'Middle Name', example: 'Dela Cruz' },
    {
      header: 'Position',
      example: 'Project Engineer',
      hint: 'Matched to the plantilla by title; an unknown title is added with 0 authorised and shows as over-complement until HR sets the count',
    },
    {
      header: 'Team',
      example: 'UI',
      hint: 'The industry team — an industry code or name (Admin › Categories). Left blank, a re-import keeps the team on file',
    },
    {
      header: 'Employment Type',
      example: 'REGULAR',
      hint: 'REGULAR, PROBATIONARY, PROJECT_BASED, CONTRACTUAL, PART_TIME or TRAINEE',
    },
    { header: 'Date Hired', example: '2024-03-01', hint: 'YYYY-MM-DD' },
    {
      header: 'Period Ends',
      example: '',
      hint: 'YYYY-MM-DD — end of the probationary or training period, for PROBATIONARY and TRAINEE',
    },
    { header: 'Mobile', example: '+63 917 000 0000' },
    { header: 'Personal Email', example: 'juan.santos@email.com' },
    { header: 'Address', example: '' },
    { header: 'Birth Date', example: '1992-07-14' },
    { header: 'Emergency Contact', example: 'Ana Santos' },
    { header: 'Emergency Phone', example: '+63 917 111 1111' },
    { header: 'Active', example: 'Yes' },
    {
      header: 'Email',
      example: 'juan.santos@gruntechnology.com',
      hint: 'Their G-CORE login: a login already on file with no employee is linked; a new address is invited (needs admin.users.create). Blank leaves the login as it is',
    },
  ],
  existing: async (row) => {
    const found = await prisma.employee.findUnique({ where: { employeeNo: row['Employee No'] } });
    return found?.id ?? null;
  },
  build: async (row) => {
    // The team is an Industry row, by code or by name. Blank sets nothing, so
    // a sheet made before the column existed never wipes a team on re-import.
    let industryId: string | undefined;
    const team = optional(row, 'Team');
    if (team) {
      const industry = await prisma.industry.findFirst({
        where: {
          OR: [{ code: { equals: team, mode: 'insensitive' } }, { name: { equals: team, mode: 'insensitive' } }],
        },
        select: { id: true, isActive: true },
      });
      if (!industry) throw new Error(`Team "${team}" is not an industry code or name`);
      if (!industry.isActive) throw new Error(`Team "${team}" is switched off`);
      industryId = industry.id;
    }

    // Resolve only. Creation waits for `write`.
    const title = optional(row, 'Position');
    let positionId: string | null = null;
    let newTitle: string | null = null;
    if (title) {
      const found = await prisma.position.findFirst({
        where: { title: { equals: title, mode: 'insensitive' } },
        select: { id: true, isActive: true },
      });
      if (found?.isActive) positionId = found.id;
      else if (found) throw new Error(`Position "${title}" is inactive — reactivate it in the Plantilla first`);
      else newTitle = title;
    }

    // The login: resolved only, as the position is.
    const email = optional(row, 'Email')?.toLowerCase() ?? null;
    const login: EmployeeImportRecord['login'] = { linkUserId: null, newLoginEmail: null };
    if (email) {
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error(`Email "${email}" is not an email address`);
      const user = await prisma.user.findUnique({
        where: { email },
        select: { id: true, employee: { select: { employeeNo: true } } },
      });
      const employeeNo = row['Employee No'];
      if (user?.employee && user.employee.employeeNo !== employeeNo) {
        throw new Error(`Email "${email}" is the login of employee ${user.employee.employeeNo}`);
      }
      if (user && !user.employee) login.linkUserId = user.id;
      if (!user) login.newLoginEmail = email;
    }

    return {
      login,
      data: {
        employeeNo: required(row, 'Employee No'),
        lastName: required(row, 'Last Name'),
        firstName: required(row, 'First Name'),
        middleName: optional(row, 'Middle Name'),
        ...(industryId ? { industryId } : {}),
        employmentType: oneOf(row, 'Employment Type', EMPLOYMENT_TYPES, 'REGULAR'),
        dateHired: date(row, 'Date Hired'),
        periodEndDate: date(row, 'Period Ends'),
        mobile: optional(row, 'Mobile'),
        personalEmail: optional(row, 'Personal Email'),
        address: optional(row, 'Address'),
        birthDate: date(row, 'Birth Date'),
        emergencyContactName: optional(row, 'Emergency Contact'),
        emergencyContactPhone: optional(row, 'Emergency Phone'),
        isActive: bool(row, 'Active'),
      },
      position: { positionId, newTitle },
    };
  },
};

export const employeesImport: Registered = {
  spec: employeeSpec as unknown as ImportSpec<never>,
  permission: 'ghr.employees.create',
  write: async (records, actor) => {
    const rows = records as unknown as { record: EmployeeImportRecord; existingId: string | null }[];
    // New logins need the account right, checked before any row is written.
    if (rows.some((r) => r.record.login.newLoginEmail)) {
      const who = actor ? await resolveUser(actor.id) : null;
      if (!who || !can(who, 'admin.users.create')) {
        throw new Error('The Email column invites new logins, which needs admin.users.create — clear the column, or ask an administrator to import');
      }
    }
    const invites: Parameters<typeof deliverLink>[] = [];
    for (const { record, existingId } of rows) {
      await prisma.$transaction(async (tx) => {
        let positionId = record.position.positionId;
        if (!positionId && record.position.newTitle) {
          // A second row in the same file may have created it a moment ago.
          const found = await tx.position.findFirst({
            where: { title: { equals: record.position.newTitle, mode: 'insensitive' } },
            select: { id: true },
          });
          positionId =
            found?.id ??
            (
              await tx.position.create({
                data: {
                  code: await nextNumber('position', tx),
                  title: record.position.newTitle,
                  authorisedHeadcount: 0,
                },
              })
            ).id;
        }
        let employeeId: string;
        if (existingId) {
          const { employeeNo, ...rest } = record.data;
          void employeeNo;
          await tx.employee.update({ where: { id: existingId }, data: rest });
          // Through the one writer of the mirror, whether linked or not.
          await setEmployeePosition(tx, existingId, positionId, null);
          employeeId = existingId;
        } else {
          employeeId = (await tx.employee.create({ data: { ...record.data, ...(await positionFields(tx, positionId, null)) } })).id;
          // A typed number moves the employee series up to it, never down.
          if (record.data.employeeNo) await setCounter('employee', record.data.employeeNo, tx, { mode: 'raise' });
        }
        const current = await tx.employee.findUnique({ where: { id: employeeId }, select: { userId: true, employeeNo: true } });
        if (!current?.userId && record.login.linkUserId) {
          await tx.employee.update({ where: { id: employeeId }, data: { userId: record.login.linkUserId } });
        } else if (!current?.userId && record.login.newLoginEmail && actor) {
          const e = await tx.employee.findUniqueOrThrow({ where: { id: employeeId } });
          const made = await createLogin(
            tx,
            {
              email: record.login.newLoginEmail,
              name: [e.firstName, e.lastName, e.suffix].filter(Boolean).join(' '),
              roleIds: await defaultRoleIds(tx),
              position: e.position,
              phone: e.mobile,
              employeeNo: e.employeeNo,
              isActive: e.isActive,
            },
            actor.id,
          );
          await tx.employee.update({ where: { id: employeeId }, data: { userId: made.user.id } });
          if (made.invite) invites.push(['INVITE', made.user, made.invite, actor.name]);
          await audit({
            entityType: 'user',
            entityId: made.user.id,
            action: 'CREATED',
            actorId: actor.id,
            summary: `Created user ${made.user.email} with employee ${e.employeeNo} from the employee import — invited`,
          });
        }
        // The login, linked or made, mirrors the record (shared/accounts.ts).
        await syncLoginFromEmployee(tx, employeeId);
      });
    }
    // The invitations go once every row stands; a mail that fails fails none.
    for (const args of invites) await deliverLink(...args).catch(() => undefined);
  },
};
