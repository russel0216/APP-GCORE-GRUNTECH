import { prisma } from '../prisma';
import { audit } from './audit';

/**
 * G-CHAIN's starting rights on the owner's roles (2026-10-19, the owner's
 * call: "now do the same for G-CHAIN common access", after G-HR's and
 * G-FIN's). Once, marked `CHAIN_ACCESS_MARK`:
 *
 * - EVERY role gets `CHAIN_COMMON` — asking to borrow a tool and raising a
 *   pull-out slip (create, View Own, Edit Own): what the old Employee role
 *   held in G-CHAIN. An Outgoing slip addressed to someone opens for them
 *   with no right at all;
 * - the roles that raise requisitions (`CHAIN_PR_ROLES`: Technical Manager,
 *   Team Leader, Sales Engineer, Project Engineer, Project Lead) get their
 *   own purchase requests — G-CHAIN's keys, which the API reads, and
 *   G-OPS's, which guard the project's Purchase Requisition tab — View Own
 *   covering their direct reports' requests;
 * - both Purchasing Managers (`purchasing_manager`,
 *   `purchasing_manager_import`) get every G-CHAIN box.
 *
 * Added, never removed; after the mark, Admin › Roles is the only thing that
 * changes them.
 */
export const CHAIN_ACCESS_MARK = 'seed.chainAccess20261019';

const OWN_SELF = (m: string, sub: string) => [`${m}.${sub}.view_own`, `${m}.${sub}.create`, `${m}.${sub}.edit_own`];

export const CHAIN_COMMON: string[] = [...OWN_SELF('gchain', 'borrow_slips'), ...OWN_SELF('gchain', 'pullout_slips')];
export const CHAIN_PR: string[] = [
  ...OWN_SELF('gchain', 'purchase_requests'),
  'gops.purchase_requests.view_own',
  'gops.purchase_requests.edit_own',
];
export const CHAIN_PR_ROLES = ['technical_manager', 'team_leader', 'industry_specialist', 'project_engineer', 'project_lead'];
export const CHAIN_MANAGER_ROLES = ['purchasing_manager', 'purchasing_manager_import'];

export async function applyChainAccess(): Promise<{ roles: number; common: number; requisitions: number; managers: number } | null> {
  if (await prisma.setting.findUnique({ where: { key: CHAIN_ACCESS_MARK } })) return null;
  const [roles, permissions] = await Promise.all([
    prisma.role.findMany({ select: { id: true, key: true, name: true } }),
    prisma.permission.findMany({ where: { OR: [{ key: { startsWith: 'gchain.' } }, { key: { startsWith: 'gops.purchase_requests.' } }] }, select: { id: true, key: true } }),
  ]);
  const idOf = new Map(permissions.map((p) => [p.key, p.id]));
  const missing = [...CHAIN_COMMON, ...CHAIN_PR].filter((k) => !idOf.has(k));
  if (missing.length) throw new Error(`G-CHAIN permissions not on file: ${missing.join(', ')}`);
  const everyChain = permissions.filter((p) => p.key.startsWith('gchain.')).map((p) => p.key);

  const tally = { common: 0, requisitions: 0, managers: 0 };
  await prisma.$transaction(
    async (tx) => {
      for (const r of roles) {
        const manager = CHAIN_MANAGER_ROLES.includes(r.key);
        const raises = CHAIN_PR_ROLES.includes(r.key);
        const keys = manager ? [...everyChain, ...CHAIN_PR] : [...CHAIN_COMMON, ...(raises ? CHAIN_PR : [])];
        const { count } = await tx.rolePermission.createMany({
          data: [...new Set(keys)].map((k) => ({ roleId: r.id, permissionId: idOf.get(k)! })),
          skipDuplicates: true,
        });
        if (manager) tally.managers += count;
        else if (raises) tally.requisitions += count;
        else tally.common += count;
        if (count) {
          await audit(
            {
              entityType: 'role',
              entityId: r.id,
              action: 'UPDATED',
              summary: manager
                ? `${r.name}: every G-CHAIN right added (${count}) — the Purchasing Manager's higher access`
                : `${r.name}: the common G-CHAIN rights added (${count}) — own borrow and pull-out slips${raises ? ', own purchase requests' : ''}`,
              after: { added: count },
            },
            undefined,
            tx,
          );
        }
      }
      await tx.setting.create({
        data: {
          key: CHAIN_ACCESS_MARK,
          value: { at: new Date().toISOString(), roles: roles.length, ...tally },
          description: "seed: G-CHAIN's common rights given to every role, the requisition roles' own purchase requests, and every G-CHAIN right to both Purchasing Managers, once (2026-10-19)",
        },
      });
    },
    { maxWait: 15_000, timeout: 120_000 },
  );
  return { roles: roles.length, ...tally };
}
