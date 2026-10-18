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

export type Scope = 'all' | 'own';

const key = (m: string, s: string, a: string) => `${m}.${s}.${a}`;

export function viewScope(me: ResolvedUser, m: string, s: string): Scope | null {
  if (can(me, key(m, s, 'view_all'))) return 'all';
  if (can(me, key(m, s, 'view_own'))) return 'own';
  return null;
}

export function editScope(me: ResolvedUser, m: string, s: string): Scope | null {
  if (can(me, key(m, s, 'edit_all'))) return 'all';
  if (can(me, key(m, s, 'edit_own'))) return 'own';
  return null;
}

/** View Own or View All. */
export function requireView(m: string, s: string): RequestHandler {
  return requireAny(key(m, s, 'view_all'), key(m, s, 'view_own'));
}

/** Edit Own or Edit All. */
export function requireEdit(m: string, s: string): RequestHandler {
  return requireAny(key(m, s, 'edit_all'), key(m, s, 'edit_own'));
}

/**
 * A list's where-clause narrowed to the caller's own records when they hold
 * View Own alone. `mine` is what "own" means on the screen.
 */
export function ownOnly<W extends object>(me: ResolvedUser, m: string, s: string, where: W, mine: object): W {
  const scope = viewScope(me, m, s);
  if (scope === 'all') return where;
  if (scope === 'own') return { AND: [where, mine] } as unknown as W;
  throw forbidden(`You need "${key(m, s, 'view_all')}" or "${key(m, s, 'view_own')}" to do this`);
}

/** One record: a View Own holder reads only their own — anybody else's is a 404, as an unknown id is. */
export function assertCanView(me: ResolvedUser, m: string, s: string, isMine: boolean): void {
  const scope = viewScope(me, m, s);
  if (scope === 'all') return;
  if (scope === 'own' && isMine) return;
  if (scope === 'own') throw notFound('Not found');
  throw forbidden(`You need "${key(m, s, 'view_all')}" or "${key(m, s, 'view_own')}" to do this`);
}

/** One record: an Edit Own holder changes only their own. */
export function assertCanEdit(me: ResolvedUser, m: string, s: string, isMine: boolean): void {
  const scope = editScope(me, m, s);
  if (scope === 'all') return;
  if (scope === 'own' && isMine) return;
  if (scope === 'own') throw forbidden('You may change only your own — this one is somebody else’s');
  throw forbidden(`You need "${key(m, s, 'edit_all')}" or "${key(m, s, 'edit_own')}" to do this`);
}

/** May the caller change this record? (for a page's buttons — never in place of the route's own check). */
export function mayEdit(me: ResolvedUser, m: string, s: string, isMine: boolean): boolean {
  const scope = editScope(me, m, s);
  return scope === 'all' || (scope === 'own' && isMine);
}
