import { Prisma } from '@prisma/client';
import { prisma } from '../../prisma';
import { required, optional, bool, date, oneOf, type ImportSpec } from '../../shared/csv';
import { nextNumber } from '../../shared/numbering';
import { positionFields, setEmployeePosition } from '../../shared/plantilla';
import type { Registered } from '../imports';

/**
 * CSV import for employees — the spec, the duplicate key and the writer,
 * registered by ../imports.ts under the `employees` entity.
 *
 * The Position column is matched to the plantilla by title. `build` only
 * RESOLVES it — `runImport` calls build on every dry run, and a dry run that
 * created positions would not be a dry run. An unknown title is created in
 * `write`, inside the row's transaction, with 0 authorised: it then shows as
 * over-complement on the Plantilla screen until HR sets the count, rather
 * than failing the row the way an unknown department does.
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
  position: { positionId: string | null; newTitle: string | null; departmentId: string | null };
}

const employeeSpec: ImportSpec<EmployeeImportRecord> = {
  entity: 'employees',
  label: 'Employees',
  columns: [
    { header: 'Employee No', required: true, example: 'GT-EMP-2026-0001' },
    { header: 'Last Name', required: true, example: 'Santos' },
    { header: 'First Name', required: true, example: 'Juan' },
    { header: 'Middle Name', example: 'Dela Cruz' },
    {
      header: 'Position',
      example: 'Project Engineer',
      hint: 'Matched to the plantilla by title; an unknown title is added with 0 authorised and shows as over-complement until HR sets the count',
    },
    { header: 'Department', example: 'Engineering', hint: 'Must match a department name' },
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
  ],
  existing: async (row) => {
    const found = await prisma.employee.findUnique({ where: { employeeNo: row['Employee No'] } });
    return found?.id ?? null;
  },
  build: async (row) => {
    let departmentId: string | null = null;
    if (row['Department']) {
      const dept = await prisma.department.findFirst({
        where: { name: { equals: row['Department'], mode: 'insensitive' } },
      });
      if (!dept) throw new Error(`Department "${row['Department']}" does not exist`);
      departmentId = dept.id;
    }

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

    return {
      data: {
        employeeNo: required(row, 'Employee No'),
        lastName: required(row, 'Last Name'),
        firstName: required(row, 'First Name'),
        middleName: optional(row, 'Middle Name'),
        departmentId,
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
      position: { positionId, newTitle, departmentId },
    };
  },
};

export const employeesImport: Registered = {
  spec: employeeSpec as unknown as ImportSpec<never>,
  permission: 'ghr.employees.create',
  write: async (records) => {
    for (const { record, existingId } of records as unknown as {
      record: EmployeeImportRecord;
      existingId: string | null;
    }[]) {
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
                  departmentId: record.position.departmentId,
                  authorisedHeadcount: 0,
                },
              })
            ).id;
        }
        if (existingId) {
          const { employeeNo, ...rest } = record.data;
          void employeeNo;
          await tx.employee.update({ where: { id: existingId }, data: rest });
          // Through the one writer of the mirror, whether linked or not.
          await setEmployeePosition(tx, existingId, positionId, null);
        } else {
          await tx.employee.create({ data: { ...record.data, ...(await positionFields(tx, positionId, null)) } });
        }
      });
    }
  },
};
