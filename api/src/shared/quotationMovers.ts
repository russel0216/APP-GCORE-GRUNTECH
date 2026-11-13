import { prisma } from '../prisma';
import type { ResolvedUser } from '../permissions/resolve';

/**
 * Who may move a quotation's STATUS (2026-11-14, the owner's call: "only the
 * owner of the quotation can move the status of its quotation, or the System
 * Administrator, or the team leader or sales manager, and/or the CEO").
 *
 * One rule for the board's drag, the quotation page's Change status, the
 * list's mass action and the Modify page's Status — all of them send the same
 * `PATCH /quotations/:id { outcome }`:
 *   - its owner;
 *   - a super admin;
 *   - the CEO / President (role key `ceo`), any quotation;
 *   - a Team Leader or Sales Manager of the QUOTATION's team — the team picked
 *     on it, else its owner's — their own team, or one whose Team managers
 *     post (Admin › Categories) names them or shares their team's.
 * Editing a quotation's other details stays `canEditRecord`'s; Manage Team /
 * Manage All no longer move a status by themselves.
 */
export const MOVER_ROLE_KEYS = ['team_leader', 'sales_manager'];
export const MOVER_ANY_ROLE_KEYS = ['ceo'];

export interface MoverScope {
  userId: string;
  /** Every quotation: a super admin or the CEO / President. */
  all: boolean;
  /** The teams they lead or manage sales for. */
  teamIds: Set<string>;
  /** The active logins on those teams — for a quotation with no team of its own. */
  memberIds: Set<string>;
}

/** The rule from what the login itself carries — no read; shared posts are `moverScope`'s. */
export function basicMoverScope(me: ResolvedUser): MoverScope {
  const all = me.isSuperAdmin || me.roleKeys.some((k) => MOVER_ANY_ROLE_KEYS.includes(k));
  const leads = me.roleKeys.some((k) => MOVER_ROLE_KEYS.includes(k)) && !!me.teamId;
  return {
    userId: me.id,
    all,
    teamIds: new Set(leads ? [me.teamId!] : []),
    memberIds: new Set(leads ? me.teamMemberIds : []),
  };
}

/** `basicMoverScope` plus the teams whose Team managers post names them, or shares their team's holders. */
export async function moverScope(me: ResolvedUser): Promise<MoverScope> {
  const scope = basicMoverScope(me);
  if (scope.all) return scope;
  const held = me.roleKeys.filter((k) => MOVER_ROLE_KEYS.includes(k));
  if (!held.length) return scope;
  const posts = await prisma.teamPost.findMany({ where: { roleKey: { in: held }, mode: { not: 'OWN' } } });
  const extra = posts
    .filter((p) => (p.mode === 'PEOPLE' ? p.userIds.includes(me.id) : !!me.teamId && p.sharedTeamIds.includes(me.teamId)))
    .map((p) => p.teamId)
    .filter((id) => !scope.teamIds.has(id));
  if (extra.length) {
    for (const id of extra) scope.teamIds.add(id);
    const members = await prisma.user.findMany({ where: { isActive: true, employee: { industryId: { in: extra } } }, select: { id: true } });
    for (const m of members) scope.memberIds.add(m.id);
  }
  return scope;
}

export function mayMoveQuotation(scope: MoverScope, q: { ownerId: string; teamId?: string | null }): boolean {
  if (scope.all || q.ownerId === scope.userId) return true;
  return q.teamId ? scope.teamIds.has(q.teamId) : scope.memberIds.has(q.ownerId);
}

export const MOVER_REFUSAL =
  'Only its owner, their Team Leader or Sales Manager, the CEO / President or the System Administrator moves a quotation’s status';
