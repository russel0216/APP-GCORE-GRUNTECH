/*
  The permission matrix (2026-10-19, the owner's call: "the permission should
  be Permission View (VIEW OWN / VIEW TEAM / VIEW ALL) and PERMISSION
  CREATE/EDIT (MANAGE OWN / MANAGE TEAM / MANAGE ALL)"). A role's right on a
  screen is two LEVELS — View and Manage, each none, own, team or all — and
  this file is the one translation between those levels and the permission
  keys the routes check (`module.screen.action`):

  - View Own → view_own; Team → + view_team; All → + view_all and export.
  - Manage Own → create, edit_own and delete (a delete route still checks
    the record is theirs, or Manage All); Team → + edit_team; All →
    + edit_all and approve.

  A level is offered only where the screen has its key (`levelOptions`): a
  report has View All alone, a calendar no Manage Team. Reading a role back
  takes the highest level whose key it holds. DOM-free and pure; the web's
  copy is web/src/lib/permissionLevels.ts, pinned equal by verify-foundation.
*/

export type Level = 'none' | 'own' | 'team' | 'all';
export const LEVELS: Level[] = ['none', 'own', 'team', 'all'];

const VIEW_KEYS: Record<Exclude<Level, 'none'>, string[]> = {
  own: ['view_own'],
  team: ['view_own', 'view_team'],
  all: ['view_own', 'view_team', 'view_all', 'export'],
};
const MANAGE_KEYS: Record<Exclude<Level, 'none'>, string[]> = {
  own: ['create', 'edit_own', 'delete'],
  team: ['create', 'edit_own', 'delete', 'edit_team'],
  all: ['create', 'edit_own', 'delete', 'edit_team', 'edit_all', 'approve'],
};

/** Which levels a screen with these actions offers on each axis ('none' always). */
export function levelOptions(actions: readonly string[]): { view: Level[]; manage: Level[] } {
  const has = (a: string) => actions.includes(a);
  const view: Level[] = ['none'];
  if (has('view_own')) view.push('own');
  if (has('view_team')) view.push('team');
  if (has('view_all')) view.push('all');
  const manage: Level[] = ['none'];
  if (has('edit_own') || has('create') || (has('delete') && !has('edit_all'))) manage.push('own');
  if (has('edit_team')) manage.push('team');
  if (has('edit_all') || has('approve')) manage.push('all');
  return { view, manage };
}

/** The levels a role holds on a screen, from the actions it holds there. */
export function levelsOf(actions: readonly string[], held: ReadonlySet<string>): { view: Level; manage: Level } {
  const h = (a: string) => actions.includes(a) && held.has(a);
  const view: Level = h('view_all') ? 'all' : h('view_team') ? 'team' : h('view_own') ? 'own' : 'none';
  const manage: Level =
    h('edit_all') || (h('approve') && !actions.includes('edit_all')) ? 'all'
      : h('edit_team') ? 'team'
        : h('edit_own') || h('create') || h('delete') ? 'own'
          : 'none';
  return { view, manage };
}

/** The actions two levels grant on a screen — only those the screen has. */
export function actionsFor(actions: readonly string[], view: Level, manage: Level): string[] {
  const want = new Set<string>([...(view === 'none' ? [] : VIEW_KEYS[view]), ...(manage === 'none' ? [] : MANAGE_KEYS[manage])]);
  return actions.filter((a) => want.has(a));
}

export const LEVEL_LABELS: Record<Level, string> = { none: '—', own: 'Own', team: 'Team', all: 'All' };
