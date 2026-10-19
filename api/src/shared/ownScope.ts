import type { RequestHandler } from 'express';
import { can, type ResolvedUser } from '../permissions/resolve';
import { forbidden, notFound } from '../http/kit';
import { requireAny } from '../auth/middleware';

/**
 * View Own and Edit Own on every screen that has Edit All (2026-10-18, the
 * owner's call: "every setting on Access should have Edit Own, View Own").
 *
 * The OWNED documents (quotations, costings …) always had the pair. The rest
 * gained it the same day, and this file is the one rule they read it by:
 *
 * - `requireView(m, s)` / `requireEdit(m, s)` let in either key of the pair;
 * - `viewScope()` / `editScope()` say which one the caller has — 'all' wins;
 * - `ownOnly(me, m, s, where)` narrows a list to the caller's own records
 *   where they hold only View Own (`where` is what "mine" means on that
 *   screen: `{ createdById: me.id }`, `{ userId: me.id }` …);
 * - `assertCanView` / `assertCanEdit` refuse one record that is not theirs.
 *
 * What "own" means on each screen is the registry entry's `own`, shown on
 * Admin › Roles. A page that keeps no record of anybody's (Company Settings,
 * Numbering …) opens and saves on either key — `requireView` /
 * `requireEdit` alone, no narrowing — and says so there.
 */

/*
  View Team and Manage Team (2026-10-19, the owner's permission matrix:
  View Own / Team / All, Manage Own / Team / All): TEAM is the caller's team
  (`Employee.industryId`, the KAT … SIT of the lists' Team view) — the
  records whose owner is on it (`me.teamMemberIds`, the caller included).
  The levels include the ones under them (`withImpliedLevels`), so the best
  one held is the scope.
*/
export type Scope = 'all' | 'team' | 'own';

const key = (m: string, s: string, a: string) => `${m}.${s}.${a}`;
const teamKey = (m: string, s: string, axis: 'view' | 'edit') => `${m}.${s}.${axis}_team`;

export function viewScope(me: ResolvedUser, m: string, s: string): Scope | null {
  if (can(me, key(m, s, 'view_all'))) return 'all';
  if (can(me, `${m}.${s}.view_team`)) return 'team';
  if (can(me, key(m, s, 'view_own'))) return 'own';
  return null;
}

export function editScope(me: ResolvedUser, m: string, s: string): Scope | null {
  if (can(me, key(m, s, 'edit_all'))) return 'all';
  if (can(me, `${m}.${s}.edit_team`)) return 'team';
  if (can(me, key(m, s, 'edit_own'))) return 'own';
  return null;
}

/** View Own, Team or All. */
export function requireView(m: string, s: string): RequestHandler {
  return requireAny(key(m, s, 'view_all'), teamKey(m, s, 'view'), key(m, s, 'view_own'));
}

/** Manage (Edit) Own, Team or All. */
export function requireEdit(m: string, s: string): RequestHandler {
  return requireAny(key(m, s, 'edit_all'), teamKey(m, s, 'edit'), key(m, s, 'edit_own'));
}

/** Is this user on the caller's team (themselves included)? */
export function onMyTeam(me: ResolvedUser, userId: string | null | undefined): boolean {
  return !!userId && me.teamMemberIds.includes(userId);
}

/**
 * "Mine" on a screen: a where-clause for records owned by these logins —
 * `[me.id]` for Own, the team's for Team. A plain object (built for the
 * caller alone) still works, and then View Team reads as View Own.
 */
export type Mine = object | ((userIds: string[]) => object);

/**
 * A list's where-clause narrowed to the caller's own records (View Own) or
 * their team's (View Team); View All reads everything. `mine` is what "own"
 * means on the screen.
 */
export function ownOnly<W extends object>(me: ResolvedUser, m: string, s: string, where: W, mine: Mine): W {
  const scope = viewScope(me, m, s);
  if (scope === 'all') return where;
  if (scope === 'team' || scope === 'own') {
    const ids = scope === 'team' ? me.teamMemberIds : [me.id];
    const clause = typeof mine === 'function' ? mine(ids) : mine;
    return { AND: [where, clause] } as unknown as W;
  }
  throw forbidden(`You need "${key(m, s, 'view_all')}" or "${key(m, s, 'view_own')}" to do this`);
}

/**
 * One record: a View Own holder reads only their own, a View Team holder
 * their team's (`owner` — the login that owns it) — anybody else's is a 404,
 * as an unknown id is.
 */
export function assertCanView(me: ResolvedUser, m: string, s: string, isMine: boolean, owner?: string | null): void {
  const scope = viewScope(me, m, s);
  if (scope === 'all') return;
  if (isMine && (scope === 'own' || scope === 'team')) return;
  if (scope === 'team' && onMyTeam(me, owner)) return;
  if (scope) throw notFound('Not found');
  throw forbidden(`You need "${key(m, s, 'view_all')}" or "${key(m, s, 'view_own')}" to do this`);
}

/** One record: a Manage Own holder changes only their own, Manage Team their team's. */
export function assertCanEdit(me: ResolvedUser, m: string, s: string, isMine: boolean, owner?: string | null): void {
  const scope = editScope(me, m, s);
  if (scope === 'all') return;
  if (isMine && (scope === 'own' || scope === 'team')) return;
  if (scope === 'team' && onMyTeam(me, owner)) return;
  if (scope) throw forbidden('You may change only your own — this one is somebody else’s');
  throw forbidden(`You need "${key(m, s, 'edit_all')}" or "${key(m, s, 'edit_own')}" to do this`);
}

/** May the caller change this record? (for a page's buttons — never in place of the route's own check). */
export function mayEdit(me: ResolvedUser, m: string, s: string, isMine: boolean, owner?: string | null): boolean {
  const scope = editScope(me, m, s);
  return scope === 'all' || (isMine && !!scope) || (scope === 'team' && onMyTeam(me, owner));
}
