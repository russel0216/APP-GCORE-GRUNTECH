import { prisma } from '../prisma';
import { audit } from './audit';

/**
 * G-HR's starting rights on the owner's roles (2026-10-18, the owner's call:
 * "in Role, modify G-HR common access, particularly clock in clock out; the
 * Human Resources Officer has higher access for G-HR"). Once, marked
 * `HR_ACCESS_MARK`, after the roles were replaced by the chart's titles:
 *
 * - EVERY role gets the self-service set (`HR_COMMON`) — Clock In/Out, one's
 *   own attendance (with one's direct reports' days, for anyone who has
 *   reports — Attendance › View Own), one's own leave and overtime, meetings,
 *   evaluation, people flow, training passport, the training calendar, and
 *   raising one's own clearance: what the old Employee role held;
 * - the Human Resources Officer (`hr`) gets every G-HR box.
 *
 * Added, never removed, so a box the owner ticked first stays; after the
 * mark, Admin › Roles is the only thing that changes them.
 */
export const HR_ACCESS_MARK = 'seed.hrAccess20261018';

const OWN_SELF = (sub: string) => [`ghr.${sub}.view_own`, `ghr.${sub}.create`, `ghr.${sub}.edit_own`];

export const HR_COMMON: string[] = [
  'ghr.clock.view_own',
  'ghr.my_records.view_own',
  'ghr.assets.view_own',
  'ghr.attendance.view_own',
  ...OWN_SELF('leave'),
  ...OWN_SELF('overtime'),
  ...OWN_SELF('meetings'),
  'ghr.clearances.view_own',
  'ghr.clearances.create',
  'ghr.evaluations.view_own',
  'ghr.people_flow.view_own',
  'ghr.training_calendar.view_all',
  'ghr.passport.view_own',
  'ghr.passport.create',
];

export const HR_OFFICER_ROLE = 'hr';

export async function applyHrAccess(): Promise<{ roles: number; common: number; officer: number } | null> {
  if (await prisma.setting.findUnique({ where: { key: HR_ACCESS_MARK } })) return null;
  const [roles, permissions] = await Promise.all([
    prisma.role.findMany({ select: { id: true, key: true, name: true } }),
    prisma.permission.findMany({ where: { key: { startsWith: 'ghr.' } }, select: { id: true, key: true } }),
  ]);
  const idOf = new Map(permissions.map((p) => [p.key, p.id]));
  const missing = HR_COMMON.filter((k) => !idOf.has(k));
  if (missing.length) throw new Error(`G-HR permissions not on file: ${missing.join(', ')}`);
  const common = HR_COMMON.map((k) => idOf.get(k)!);
  const all = permissions.map((p) => p.id);

  let commonAdded = 0;
  let officerAdded = 0;
  await prisma.$transaction(
    async (tx) => {
      for (const r of roles) {
        const officer = r.key === HR_OFFICER_ROLE;
        const ids = officer ? all : common;
        const { count } = await tx.rolePermission.createMany({
          data: ids.map((permissionId) => ({ roleId: r.id, permissionId })),
          skipDuplicates: true,
        });
        if (officer) officerAdded = count;
        else commonAdded += count;
        if (count) {
          await audit(
            {
              entityType: 'role',
              entityId: r.id,
              action: 'UPDATED',
              summary: officer
                ? `${r.name}: every G-HR right added (${count}) — the HR Officer's higher access`
                : `${r.name}: the common G-HR rights added (${count}) — Clock In/Out, own attendance, leave, overtime and the rest`,
              after: { added: count },
            },
            undefined,
            tx,
          );
        }
      }
      await tx.setting.create({
        data: {
          key: HR_ACCESS_MARK,
          value: { at: new Date().toISOString(), roles: roles.length, commonAdded, officerAdded },
          description: "seed: G-HR's common rights given to every role and every G-HR right to the HR Officer, once (2026-10-18)",
        },
      });
    },
    { maxWait: 15_000, timeout: 120_000 },
  );
  return { roles: roles.length, common: commonAdded, officer: officerAdded };
}
