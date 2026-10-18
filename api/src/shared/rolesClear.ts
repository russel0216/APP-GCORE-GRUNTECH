import { prisma } from '../prisma';
import { audit } from './audit';

/**
 * The roles emptied (2026-10-18, the owner's call: "delete all roles, I will
 * create the roles later"; his choice between deleting the rows and emptying
 * them: empty). Once, marked `ROLES_CLEARED_MARK`:
 *
 * - every permission comes off every role and every role off every person
 *   (the "Supports teams" ticks and the overrides stay — they are the
 *   person's, not a role's);
 * - the built-in mark (`isSystem`) is lifted from all of them, so each can be
 *   renamed, refilled or deleted on Admin › Roles — the Delete route's
 *   refusal of a built-in role no longer bites;
 * - the ROWS stay: the 47 approval routes keep their steps, and the keys the
 *   engine gives a meaning of their own (`team_leader`, `technical_manager`,
 *   `service_manager`, `back_support`, `purchasing_manager` and its
 *   importation twin, `hr`, `ceo`, `executive`, `employee`, `supervisor`,
 *   `warehouse_supervisor`) keep it, whatever the owner calls them.
 *
 * From then on the seed neither recreates a role nor offers it permissions
 * (`prisma/seed.ts` reads the mark): the grid is the owner's.
 */
export const ROLES_CLEARED_MARK = 'seed.rolesCleared20261018';

/** The role keys the approval engine, the accounts and the seed read by KEY — Admin › Roles names them on the New role form. */
export const ENGINE_ROLE_KEYS: { key: string; meaning: string }[] = [
  { key: 'team_leader', meaning: 'a "Team Leader" step goes to its holder on the requester\'s own team first' },
  { key: 'technical_manager', meaning: 'a Technical Manager step goes to the holder on the requester\'s team' },
  { key: 'service_manager', meaning: 'a Service Manager step goes to the holder on the requester\'s team' },
  { key: 'back_support', meaning: 'a Back Support step goes to the holders supporting the requester\'s team' },
  { key: 'purchasing_manager', meaning: 'the local Purchasing Manager; an importation order goes to the twin below' },
  { key: 'purchasing_manager_import', meaning: 'the Purchasing Manager for importation orders' },
  { key: 'hr', meaning: 'the HR approver type (overtime, clearances, evaluations, training) reads its holders' },
  { key: 'ceo', meaning: 'the CEO / President steps' },
  { key: 'executive', meaning: 'the Management steps and the engine\'s fallback' },
  { key: 'employee', meaning: 'given to every new login' },
  { key: 'supervisor', meaning: 'given on every deploy to anyone with a direct report' },
  { key: 'warehouse_supervisor', meaning: 'the warehouse routes\' fallback and the automatic reorder\'s requester' },
];

export async function rolesCleared(): Promise<boolean> {
  return !!(await prisma.setting.findUnique({ where: { key: ROLES_CLEARED_MARK } }));
}

export async function clearRoles(): Promise<{ roles: number; permissions: number; holders: number } | null> {
  if (await rolesCleared()) return null;
  const roles = await prisma.role.findMany({
    select: { id: true, key: true, name: true, isSystem: true, _count: { select: { permissions: true, users: true } } },
    orderBy: { key: 'asc' },
  });
  let permissions = 0;
  let holders = 0;
  await prisma.$transaction(
    async (tx) => {
      for (const r of roles) {
        const [p, u] = await Promise.all([
          tx.rolePermission.deleteMany({ where: { roleId: r.id } }),
          tx.userRole.deleteMany({ where: { roleId: r.id } }),
        ]);
        permissions += p.count;
        holders += u.count;
        await tx.role.update({ where: { id: r.id }, data: { isSystem: false } });
        await audit(
          {
            entityType: 'role',
            entityId: r.id,
            action: 'UPDATED',
            summary: `Emptied the role ${r.name} — ${p.count} permission(s) and ${u.count} holder(s) removed, the built-in mark lifted — for the owner's roles of 2026-10-18`,
            before: { permissions: r._count.permissions, holders: r._count.users, isSystem: r.isSystem },
            after: { permissions: 0, holders: 0, isSystem: false },
          },
          undefined,
          tx,
        );
      }
      await tx.setting.create({
        data: {
          key: ROLES_CLEARED_MARK,
          value: { at: new Date().toISOString(), roles: roles.length, permissions, holders },
          description: 'seed: every role was emptied once (2026-10-18); the seed no longer recreates or refills roles',
        },
      });
    },
    { maxWait: 15_000, timeout: 120_000 },
  );
  return { roles: roles.length, permissions, holders };
}
