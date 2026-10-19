import { prisma } from '../prisma';
import { audit } from './audit';
import { syncLoginFromEmployee } from './accounts';
import { nextNumber } from './numbering';

/**
 * The seed's two one-time steps for "the employee owns identity"
 * (2026-10-16, the owner's call: "employee creation and user login should be
 * one only"). Both are marked in a Setting so they run once per install.
 */

const BACKFILL_MARK = 'seed.loginMirrorBackfilled';
const ADMIN_MARK = 'seed.adminEmployeeLinked';

/**
 * Every linked login takes its employee's name, number, phone and
 * position once — what `syncLoginFromEmployee` keeps in step from now on. A
 * login whose number another login already holds is left as it is and named
 * on the audit row, for an administrator to settle on Admin › Users.
 */
export async function backfillLoginMirrors(): Promise<{ changed: number; refused: string[] }> {
  if (await prisma.setting.findUnique({ where: { key: BACKFILL_MARK } })) return { changed: 0, refused: [] };
  const linked = await prisma.employee.findMany({ where: { userId: { not: null } }, select: { id: true, employeeNo: true } });
  let changed = 0;
  const refused: string[] = [];
  for (const e of linked) {
    try {
      const fields = await prisma.$transaction((tx) => syncLoginFromEmployee(tx, e.id));
      if (fields.length) changed++;
    } catch {
      refused.push(e.employeeNo ?? e.id);
    }
  }
  if (changed || refused.length) {
    await audit({
      entityType: 'user',
      entityId: 'list',
      action: 'UPDATED',
      summary:
        `Logins brought in step with their employee records: ${changed} changed` +
        (refused.length ? `; left as they were (an employee number on another login): ${refused.join(', ')}` : ''),
      after: { changed, refused },
    });
  }
  await prisma.setting.create({ data: { key: BACKFILL_MARK, value: { at: new Date().toISOString(), changed, refused } } });
  return { changed, refused };
}

/**
 * A super admin with no employee record gets one — the clock, People Flow and
 * every "my team" view read the employee. Its number is the next employee
 * number; the name is split at the last space. Once per install.
 */
export async function linkAdminEmployees(): Promise<number> {
  if (await prisma.setting.findUnique({ where: { key: ADMIN_MARK } })) return 0;
  const admins = await prisma.user.findMany({
    where: { isSuperAdmin: true, isActive: true, employee: { is: null } },
    select: { id: true, name: true, position: true, phone: true },
  });
  for (const a of admins) {
    const parts = a.name.trim().split(/\s+/);
    const lastName = parts.length > 1 ? parts.pop()! : 'Administrator';
    const firstName = parts.join(' ') || a.name.trim() || 'G-CORE';
    await prisma.$transaction(async (tx) => {
      const employee = await tx.employee.create({
        data: {
          employeeNo: await nextNumber('employee', tx),
          firstName,
          lastName,
          position: a.position,
          mobile: a.phone,
          userId: a.id,
        },
      });
      await syncLoginFromEmployee(tx, employee.id);
      await audit(
        {
          entityType: 'employee',
          entityId: employee.id,
          action: 'CREATED',
          summary: `Created employee ${employee.employeeNo} for the administrator ${a.name} — every login is a person on the register`,
        },
        undefined,
        tx,
      );
    });
  }
  await prisma.setting.create({ data: { key: ADMIN_MARK, value: { at: new Date().toISOString(), linked: admins.length } } });
  return admins.length;
}
