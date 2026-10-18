import { prisma } from '../prisma';

/**
 * The boxes of 2026-10-18 (the owner's call: "check menu of Access, appear
 * all needed — view all, edit all, view own, edit own, or anything necessary;
 * I will manage per role later"). Four screens wrote with another screen's
 * right; each now has its own boxes on Admin › Roles. So that nobody loses
 * what they could do the day before, this runs ONCE (`seed.accessSplit20261018`)
 * and gives every role — and every person allowed by override — holding the
 * borrowed right the new ones. From then on the boxes are the owner's to set.
 */
const MARK = 'seed.accessSplit20261018';

export const ACCESS_SPLIT: { from: string; to: string[] }[] = [
  // Booking, changing and removing activities needed only the calendar's view.
  {
    from: 'gops.calendar.view_all',
    to: ['gops.calendar.create', 'gops.calendar.edit_own', 'gops.calendar.edit_all', 'gops.calendar.delete'],
  },
  // A correction to an attendance entry borrowed Employees › Edit All.
  { from: 'ghr.employees.edit_all', to: ['ghr.attendance.view_all', 'ghr.attendance.edit_all'] },
  // A call-out, a visit's move and the report templates borrowed PM › Create.
  {
    from: 'gops.pm_reports.create',
    to: ['gops.visits.create', 'gops.visits.edit_all', 'gops.report_templates.create', 'gops.report_templates.edit_all'],
  },
];

/** Returns how many grants it made, or null when it had already run. */
export async function splitBorrowedRights(): Promise<number | null> {
  if (await prisma.setting.findUnique({ where: { key: MARK } })) return null;
  const perms = new Map(
    (await prisma.permission.findMany({ select: { id: true, key: true } })).map((p) => [p.key, p.id]),
  );
  let granted = 0;
  for (const { from, to } of ACCESS_SPLIT) {
    const fromId = perms.get(from);
    const toIds = to.map((k) => perms.get(k)).filter((id): id is string => !!id);
    if (!fromId || !toIds.length) continue;
    const roles = await prisma.rolePermission.findMany({ where: { permissionId: fromId }, select: { roleId: true } });
    if (roles.length) {
      const made = await prisma.rolePermission.createMany({
        data: roles.flatMap((r) => toIds.map((permissionId) => ({ roleId: r.roleId, permissionId }))),
        skipDuplicates: true,
      });
      granted += made.count;
    }
    const allowed = await prisma.userPermissionOverride.findMany({
      where: { permissionId: fromId, effect: 'ALLOW' },
      select: { userId: true },
    });
    if (allowed.length) {
      const made = await prisma.userPermissionOverride.createMany({
        data: allowed.flatMap((u) => toIds.map((permissionId) => ({ userId: u.userId, permissionId, effect: 'ALLOW' as const }))),
        skipDuplicates: true,
      });
      granted += made.count;
    }
  }
  await prisma.setting.create({
    data: {
      key: MARK,
      value: { at: new Date().toISOString(), granted },
      description: 'The Calendar, Attendance, Service Schedule and Report Templates boxes were given, once, to whoever held the right they borrowed.',
    },
  });
  return granted;
}
