import { Prisma } from '@prisma/client';
import { prisma } from '../../prisma';
import { required, optional, bool, date, oneOf, type ImportSpec } from '../../shared/csv';
import type { Registered } from '../imports';

/**
 * CSV import for employees — the spec, the duplicate key and the writer,
 * registered by ../imports.ts under the `employees` entity.
 */

const EMPLOYMENT_TYPES = [
  'REGULAR',
  'PROBATIONARY',
  'PROJECT_BASED',
  'CONTRACTUAL',
  'PART_TIME',
  'TRAINEE',
] as const;

const employeeSpec: ImportSpec<Prisma.EmployeeCreateInput> = {
  entity: 'employees',
  label: 'Employees',
  columns: [
    { header: 'Employee No', required: true, example: 'GT-EMP-2026-0001' },
    { header: 'Last Name', required: true, example: 'Santos' },
    { header: 'First Name', required: true, example: 'Juan' },
    { header: 'Middle Name', example: 'Dela Cruz' },
    { header: 'Position', example: 'Project Engineer' },
    { header: 'Department', example: 'Engineering', hint: 'Must match a department name' },
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
    return {
      employeeNo: required(row, 'Employee No'),
      lastName: required(row, 'Last Name'),
      firstName: required(row, 'First Name'),
      middleName: optional(row, 'Middle Name'),
      position: optional(row, 'Position'),
      department: departmentId ? { connect: { id: departmentId } } : undefined,
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
    };
  },
};

export const employeesImport: Registered = {
  spec: employeeSpec as ImportSpec<never>,
  permission: 'ghr.employees.create',
  write: async (records) => {
    for (const { record, existingId } of records as unknown as {
      record: Prisma.EmployeeCreateInput;
      existingId: string | null;
    }[]) {
      if (existingId) {
        const { employeeNo, ...fields } = record;
        void employeeNo;
        await prisma.employee.update({ where: { id: existingId }, data: fields });
      } else {
        await prisma.employee.create({ data: record });
      }
    }
  },
};
