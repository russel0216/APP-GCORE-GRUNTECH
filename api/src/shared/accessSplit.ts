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

export const ACCESS_SPLIT: { key: string; from: string; to: string[] }[] = [
  // Booking, changing and removing activities needed only the calendar's view.
  {
    key: 'calendar',
    from: 'gops.calendar.view_all',
    to: ['gops.calendar.create', 'gops.calendar.edit_own', 'gops.calendar.edit_all', 'gops.calendar.delete'],
  },
  // A correction to an attendance entry borrowed Employees › Edit All.
  { key: 'attendance', from: 'ghr.employees.edit_all', to: ['ghr.attendance.view_all', 'ghr.attendance.edit_all'] },
  // A call-out, a visit's move and the report templates borrowed PM › Create.
  {
    key: 'visits',
    from: 'gops.pm_reports.create',
    to: ['gops.visits.create', 'gops.visits.edit_all', 'gops.report_templates.create', 'gops.report_templates.edit_all'],
  },
  // Pull-out slips became OWNED_KEPT (2026-10-18: anyone raises one): whoever
  // raised them keeps reading and changing their own.
  { key: 'pullout', from: 'gchain.pullout_slips.create', to: ['gchain.pullout_slips.view_own', 'gchain.pullout_slips.edit_own'] },
  // Repayments and money out left Collections (2026-10-20) for a register of
  // their own: whoever read the one register reads the new one.
  { key: 'payments-out', from: 'gfin.payments.view_all', to: ['gfin.payments_out.view_all'] },
  { key: 'payments-out-ap', from: 'gfin.ap.view_all', to: ['gfin.payments_out.view_all'] },
  // The office's operations budget (2026-10-20): read where Budget vs Actual
  // is read, set where Finance Settings are.
  { key: 'operations-budget-view', from: 'gfin.budget_vs_actual.view_all', to: ['gfin.operations_budget.view_all'] },
  { key: 'operations-budget-edit', from: 'gfin.settings.edit_all', to: ['gfin.operations_budget.view_all', 'gfin.operations_budget.edit_all'] },
];
/** The splits the first version of this step ran under its one mark. */
const FIRST_RUN = ['calendar', 'attendance', 'visits'];

/** Returns how many grants it made, or null when every split had already run. Each split runs once. */
export async function splitBorrowedRights(): Promise<number | null> {
  const mark = await prisma.setting.findUnique({ where: { key: MARK } });
  const stored = mark?.value as { done?: string[] } | null | undefined;
  const done = new Set<string>(mark ? (stored?.done ?? FIRST_RUN) : []);
  const todo = ACCESS_SPLIT.filter((x) => !done.has(x.key));
  if (!todo.length) return null;
  const perms = new Map(
    (await prisma.permission.findMany({ select: { id: true, key: true } })).map((p) => [p.key, p.id]),
  );
  let granted = 0;
  for (const { key, from, to } of todo) {
    done.add(key);
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
  const value = { done: [...done], at: new Date().toISOString(), granted };
  await prisma.setting.upsert({
    where: { key: MARK },
    create: {
      key: MARK,
      value,
      description: 'The Access boxes given, once each, to whoever held the right they replace (calendar, attendance, visits, pullout, payments-out, operations-budget).',
    },
    update: { value },
  });
  return granted;
}
