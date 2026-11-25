import type { ResolvedUser } from '../permissions/resolve';
import { prisma } from '../prisma';
import { activeSupervisor } from './approvals';
import { OUTGOING_ALSO_ROLES, OUTGOING_RAISER_ROLE } from './outgoingRaisers';

/**
 * Who MODIFIES or DELETES an item (2026-11-25, the owner's call: "delete or
 * modification only access by warehouse supervisor and his manager"). The
 * rule of the Outgoing slip's raisers: the Warehouse Officer — the
 * `warehouse_supervisor` role — the person that officer reports to, the CEO /
 * President, and a super admin always. Each still needs Item Master's Edit
 * right from Admin › Roles (the routes ask it first); the right alone, on
 * anybody else, changes nothing any more.
 *
 * Read by `PATCH /items/:id`, `DELETE /items/:id`, the photo routes and the
 * bin of a stock line (`PATCH /inventory/balances/:id`), and sent to the
 * screens as `canEdit` / `canDelete` / `canManageItems`. ADDING an item stays
 * with Item Master's Create right: an Incoming files new items as it is saved.
 */
export const ITEM_MANAGER_REFUSAL =
  'Items are changed or deleted by the Warehouse Officer, the person they report to and the CEO / President';

export async function mayManageItems(me: ResolvedUser): Promise<boolean> {
  if (me.isSuperAdmin) return true;
  if (me.roleKeys.includes(OUTGOING_RAISER_ROLE) || OUTGOING_ALSO_ROLES.some((k) => me.roleKeys.includes(k))) return true;
  const officers = await prisma.user.findMany({
    where: { isActive: true, roles: { some: { role: { key: OUTGOING_RAISER_ROLE } } } },
    select: { id: true },
  });
  for (const o of officers) {
    if ((await activeSupervisor(o.id)) === me.id) return true;
  }
  return false;
}
