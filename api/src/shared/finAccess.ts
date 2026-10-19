import { prisma } from '../prisma';
import { audit } from './audit';

/**
 * G-FIN's starting rights on the owner's roles (2026-10-19, the owner's call:
 * "now do the same for G-FIN common access", after G-HR's). Once, marked
 * `FIN_ACCESS_MARK`:
 *
 * - EVERY role gets `FIN_COMMON` — filing, seeing and changing one's own
 *   reimbursements (claims and liquidations) and cash advances: what the old
 *   Employee role held in G-FIN;
 * - the selling roles (`FIN_SALES_ROLES`: Team Leader, Sales Manager, Sales
 *   Engineer) get their own Invoice Requests and Commission Requests to raise
 *   — View Own covers one's direct reports' too, so a Team Leader reads the
 *   requests their team raised;
 * - the Finance Manager (`finance_manager`) gets every G-FIN box.
 *
 * Added, never removed; after the mark, Admin › Roles is the only thing that
 * changes them.
 */
export const FIN_ACCESS_MARK = 'seed.finAccess20261019';

const OWN_SELF = (sub: string) => [`gfin.${sub}.view_own`, `gfin.${sub}.create`, `gfin.${sub}.edit_own`];

export const FIN_COMMON: string[] = [...OWN_SELF('expenses'), ...OWN_SELF('cash_advances')];
export const FIN_SALES: string[] = [...OWN_SELF('invoice_requests'), ...OWN_SELF('commissions')];
export const FIN_SALES_ROLES = ['team_leader', 'sales_manager', 'industry_specialist'];
export const FIN_MANAGER_ROLE = 'finance_manager';

export async function applyFinAccess(): Promise<{ roles: number; common: number; sales: number; manager: number } | null> {
  if (await prisma.setting.findUnique({ where: { key: FIN_ACCESS_MARK } })) return null;
  const [roles, permissions] = await Promise.all([
    prisma.role.findMany({ select: { id: true, key: true, name: true } }),
    prisma.permission.findMany({ where: { key: { startsWith: 'gfin.' } }, select: { id: true, key: true } }),
  ]);
  const idOf = new Map(permissions.map((p) => [p.key, p.id]));
  const missing = [...FIN_COMMON, ...FIN_SALES].filter((k) => !idOf.has(k));
  if (missing.length) throw new Error(`G-FIN permissions not on file: ${missing.join(', ')}`);

  const tally = { common: 0, sales: 0, manager: 0 };
  await prisma.$transaction(
    async (tx) => {
      for (const r of roles) {
        const manager = r.key === FIN_MANAGER_ROLE;
        const selling = FIN_SALES_ROLES.includes(r.key);
        const keys = manager ? permissions.map((p) => p.key) : [...FIN_COMMON, ...(selling ? FIN_SALES : [])];
        const { count } = await tx.rolePermission.createMany({
          data: keys.map((k) => ({ roleId: r.id, permissionId: idOf.get(k)! })),
          skipDuplicates: true,
        });
        if (manager) tally.manager = count;
        else if (selling) tally.sales += count;
        else tally.common += count;
        if (count) {
          await audit(
            {
              entityType: 'role',
              entityId: r.id,
              action: 'UPDATED',
              summary: manager
                ? `${r.name}: every G-FIN right added (${count}) — the Finance Manager's higher access`
                : `${r.name}: the common G-FIN rights added (${count}) — own reimbursements and cash advances${selling ? ', own invoice and commission requests' : ''}`,
              after: { added: count },
            },
            undefined,
            tx,
          );
        }
      }
      await tx.setting.create({
        data: {
          key: FIN_ACCESS_MARK,
          value: { at: new Date().toISOString(), roles: roles.length, ...tally },
          description: "seed: G-FIN's common rights given to every role, the selling roles' own requests, and every G-FIN right to the Finance Manager, once (2026-10-19)",
        },
      });
    },
    { maxWait: 15_000, timeout: 120_000 },
  );
  return { roles: roles.length, ...tally };
}
