import { prisma } from '../prisma';
import { can, type ResolvedUser } from '../permissions/resolve';
import { activeSupervisor } from './approvals';

/**
 * Who RAISES an Outgoing slip (2026-11-24, the owner's call: "make this
 * outgoing creation only for Jeric and where he reports to"). The Warehouse
 * Officer — the `warehouse_supervisor` role, Jeric Gasiong — the person
 * that officer reports to (their active "Reports to", Dina Gasiong) and the
 * CEO / President (`ceo`, Carter Gasiong — added the same day), each
 * still holding Outgoing's create right; a super admin always. Anyone else
 * holding Create on Admin › Roles reads, confirms what was issued to them and
 * changes what they may change, but starts no new slip and issues none.
 *
 * Read by `POST /stock-issues`, `POST /stock-issues/:id/issue` and the
 * submit of a draft, and sent to the page as `canRaise`.
 */
export const OUTGOING_RAISER_ROLE = 'warehouse_supervisor';
export const OUTGOING_ALSO_ROLES = ['ceo'];

export const OUTGOING_RAISER_REFUSAL =
  'Outgoing slips are raised by the Warehouse Officer, the person they report to and the CEO / President';

export async function mayRaiseOutgoing(me: ResolvedUser): Promise<boolean> {
  if (me.isSuperAdmin) return true;
  if (!can(me, 'gchain.stock_issuance.create')) return false;
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
