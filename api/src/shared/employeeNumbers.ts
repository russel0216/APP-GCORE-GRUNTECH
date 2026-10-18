import { prisma } from '../prisma';
import { audit } from './audit';
import { EMPLOYEE_NUMBERING } from './numbering';

/**
 * The employee number ruling of 2026-10-18 (the owner's call: "the existing
 * number is manual, `GTC-0001-14` for Carter Gasiong; update the ruling,
 * particularly in quotation numbering; delete all existing employee numbers
 * in the user"). Two once-only steps, run by the seed and marked in Settings:
 *
 * - the employee numbering pattern becomes `GTC-{SEQ}-{YY}` — the person's
 *   sequence, then the year HIRED — where the STOCK pattern still stood; a
 *   pattern an administrator set stays (every numbering rule's promise);
 * - every employee number is cleared, on the employee record and on the
 *   login that mirrors it, audited per person with the old number in
 *   `before`, for the owner to type the real ones on Admin › Users. The
 *   counter is never lowered; a typed number raises it (`setCounter`).
 */
export const NUMBERING_MARK = 'seed.employeeNumbering20261018';
export const CLEARED_MARK = 'seed.employeeNumbersCleared20261018';

/** The stock pattern the seed gave the employee number before the ruling. */
const STOCK_PATTERN = '{PREFIX}-{TYPE}-{YYYY}-{SEQ}';

export async function applyEmployeeNumbering(): Promise<'applied' | 'kept' | null> {
  if (await prisma.setting.findUnique({ where: { key: NUMBERING_MARK } })) return null;
  const template = await prisma.numberSequence.findFirst({ where: { documentType: 'employee', periodKey: '' } });
  const stock = !!template && template.pattern === STOCK_PATTERN;
  if (template && stock) {
    await prisma.numberSequence.update({ where: { id: template.id }, data: { ...EMPLOYEE_NUMBERING } });
    await audit({
      entityType: 'number_sequence',
      entityId: 'employee',
      action: 'UPDATED',
      summary: `Employee numbering set to ${EMPLOYEE_NUMBERING.pattern} (the sequence, then the year hired) — the owner's scheme of 2026-10-18`,
      before: { pattern: template.pattern, period: template.period, scope: template.scope, padding: template.padding },
      after: { ...EMPLOYEE_NUMBERING },
    });
  }
  await prisma.setting.create({
    data: {
      key: NUMBERING_MARK,
      value: { at: new Date().toISOString(), applied: stock, pattern: template?.pattern ?? null },
      description: 'seed: the employee numbering pattern of 2026-10-18 (GTC-{SEQ}-{YY}) was applied once where the stock pattern stood',
    },
  });
  return stock ? 'applied' : 'kept';
}

export async function clearEmployeeNumbers(): Promise<{ employees: number; logins: number } | null> {
  if (await prisma.setting.findUnique({ where: { key: CLEARED_MARK } })) return null;
  const [employees, logins] = await Promise.all([
    prisma.employee.findMany({ where: { employeeNo: { not: null } }, select: { id: true, employeeNo: true, firstName: true, lastName: true } }),
    prisma.user.findMany({ where: { employeeNo: { not: null } }, select: { id: true, employeeNo: true, email: true } }),
  ]);
  await prisma.$transaction(
    async (tx) => {
      for (const e of employees) {
        await tx.employee.update({ where: { id: e.id }, data: { employeeNo: null } });
        await audit(
          {
            entityType: 'employee',
            entityId: e.id,
            action: 'UPDATED',
            summary: `Employee number ${e.employeeNo} cleared — to be typed under the GTC-0001-14 scheme (2026-10-18)`,
            before: { employeeNo: e.employeeNo },
            after: { employeeNo: null },
          },
          undefined,
          tx,
        );
      }
      for (const u of logins) {
        await tx.user.update({ where: { id: u.id }, data: { employeeNo: null } });
        await audit(
          {
            entityType: 'user',
            entityId: u.id,
            action: 'UPDATED',
            summary: `Employee number ${u.employeeNo} cleared from the login ${u.email} — it follows the employee record's (2026-10-18)`,
            before: { employeeNo: u.employeeNo },
            after: { employeeNo: null },
          },
          undefined,
          tx,
        );
      }
      await tx.setting.create({
        data: {
          key: CLEARED_MARK,
          value: { at: new Date().toISOString(), employees: employees.length, logins: logins.length },
          description: 'seed: every employee number was cleared once (2026-10-18) for the owner to type the GTC-0001-14 scheme',
        },
      });
    },
    { maxWait: 15_000, timeout: 120_000 },
  );
  return { employees: employees.length, logins: logins.length };
}
