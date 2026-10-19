/*
  The role hierarchy (2026-10-19, the owner's call: "remove the department,
  create a hierarchy"). A role's LEVEL is `Role.rank` (ROLE_REV1: 1 is the
  CEO / President); a person's title is their highest role. Admin › Users'
  Access tab and Admin › Roles list the roles under their level, top first;
  a role with no level (one made by hand and not placed) comes last.
  DOM-free, so a verify script may import it.
*/

export const ROLE_LEVELS: Record<number, string> = {
  1: 'Executive',
  2: 'Heads',
  3: 'Managers and officers',
  4: 'Engineers, staff and clerks',
  5: 'Leads and technicians',
  6: 'Support and skilled',
};

/** "Level 2 — Heads"; "Not placed on a level" for none. */
export function levelLabel(rank: number | null | undefined): string {
  if (rank == null) return 'Not placed on a level';
  return ROLE_LEVELS[rank] ? `Level ${rank} — ${ROLE_LEVELS[rank]}` : `Level ${rank}`;
}

/** Roles under their level, top level first; within a level, the order they came in (the chart's). */
export function rolesByLevel<T extends { rank?: number | null }>(roles: T[]): { rank: number | null; label: string; roles: T[] }[] {
  const groups = new Map<number | null, T[]>();
  for (const r of roles) {
    const k = r.rank ?? null;
    groups.set(k, [...(groups.get(k) ?? []), r]);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => (a == null ? 1 : b == null ? -1 : a - b))
    .map(([rank, list]) => ({ rank, label: levelLabel(rank), roles: list }));
}
