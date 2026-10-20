import { prisma } from '../prisma';
import { REGISTRY, type ModuleDef } from './registry';
import { isChosenReceiver, RECEIVER_RIGHTS } from '../shared/helpReceivers';

export interface ResolvedUser {
  id: string;
  email: string;
  name: string;
  position: string | null;
  isSuperAdmin: boolean;
  supervisorId: string | null;
  roleKeys: string[];
  /** Effective permission keys: the roles' (no per-person overrides since 2026-10-19). */
  permissions: Set<string>;
  /** Their team (`Employee.industryId`), and its active members' logins, themselves included — View / Manage Team. */
  teamId: string | null;
  teamMemberIds: string[];
}

/**
 * A level includes the ones under it (2026-10-19, the owner's permission
 * matrix: View Own / Team / All, Manage Own / Team / All): All counts as
 * Team and Own, Team as Own — so a role ticked "All" passes every gate a
 * Team or Own holder passes.
 */
export function withImpliedLevels(keys: Iterable<string>): Set<string> {
  const out = new Set(keys);
  for (const k of [...out]) {
    const m = /^(.*)\.(view|edit)_(all|team)$/.exec(k);
    if (!m) continue;
    out.add(`${m[1]}.${m[2]}_own`);
    if (m[3] === 'all') out.add(`${m[1]}.${m[2]}_team`);
  }
  return out;
}

/** The keys that grant this one: itself, and the levels above it (`impliedBy('x.y.view_own')` → own, team, all). */
export function impliedBy(key: string): string[] {
  const m = /^(.*)\.(view|edit)_(own|team)$/.exec(key);
  if (!m) return [key];
  return m[3] === 'own'
    ? [key, `${m[1]}.${m[2]}_team`, `${m[1]}.${m[2]}_all`]
    : [key, `${m[1]}.${m[2]}_all`];
}

/**
 * Effective permissions = the union of the person's roles' permissions, each
 * level including the ones under it. Per-person ALLOW / DENY overrides were
 * removed on 2026-10-19 (the owner's call: access is the role matrix alone);
 * the help-ticket receivers keep their two rights (shared/helpReceivers.ts).
 */
export async function resolveUser(userId: string): Promise<ResolvedUser | null> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: {
      roles: { include: { role: { include: { permissions: { include: { permission: true } } } } } },
      employee: { select: { industryId: true } },
    },
  });
  if (!user || !user.isActive) return null;

  const keys: string[] = [];
  for (const ur of user.roles) {
    for (const rp of ur.role.permissions) keys.push(rp.permission.key);
  }
  // Whoever a super admin chose to receive the Help box's tickets holds the
  // screen's two rights, whatever their roles (shared/helpReceivers.ts).
  if (await isChosenReceiver(user.id)) keys.push(...RECEIVER_RIGHTS);
  const granted = withImpliedLevels(keys);

  const teamId = user.employee?.industryId ?? null;
  const teamMemberIds = teamId
    ? (
        await prisma.user.findMany({
          where: { isActive: true, employee: { industryId: teamId } },
          select: { id: true },
        })
      ).map((u) => u.id)
    : [];
  if (!teamMemberIds.includes(user.id)) teamMemberIds.push(user.id);

  return {
    id: user.id,
    email: user.email,
    name: user.name,
    position: user.position,
    isSuperAdmin: user.isSuperAdmin,
    supervisorId: user.supervisorId,
    roleKeys: user.roles.map((r) => r.role.key),
    permissions: granted,
    teamId,
    teamMemberIds,
  };
}

export function can(user: ResolvedUser, permissionKey: string): boolean {
  if (user.isSuperAdmin) return true;
  return user.permissions.has(permissionKey);
}

/** True if the user may see the screen at all — either scope of "view" counts. */
export function canView(user: ResolvedUser, moduleKey: string, submoduleKey: string): boolean {
  return (
    can(user, `${moduleKey}.${submoduleKey}.view_all`) ||
    can(user, `${moduleKey}.${submoduleKey}.view_team`) ||
    can(user, `${moduleKey}.${submoduleKey}.view_own`)
  );
}

/**
 * Whether a user may edit one specific record.
 *
 * "Only the author can edit the quotations (note: super admin can access and
 * edit all)" — record ownership is a first-class rule, not an afterthought
 * (model §2.7).
 */
export function canEditRecord(
  user: ResolvedUser,
  moduleKey: string,
  submoduleKey: string,
  ownerId: string | null,
): boolean {
  if (can(user, `${moduleKey}.${submoduleKey}.edit_all`)) return true;
  if (!ownerId) return false;
  // Manage Team (2026-10-19): a record owned by anyone on the caller's team.
  if (can(user, `${moduleKey}.${submoduleKey}.edit_team`) && user.teamMemberIds.includes(ownerId)) return true;
  return ownerId === user.id && can(user, `${moduleKey}.${submoduleKey}.edit_own`);
}

export interface MenuSubmodule {
  key: string;
  label: string;
  path: string;
  phase: number;
  note?: string;
  /** Sidebar heading this screen sits under; see SubmoduleDef.group. */
  group?: string;
  /** Off the menu, still a screen; see SubmoduleDef.hidden. */
  hidden?: boolean;
  actions: string[];
}
export interface MenuModule {
  key: string;
  label: string;
  blurb: string;
  submodules: MenuSubmodule[];
}

/**
 * The menu this specific user sees. Built from the same registry the
 * permissions come from, so a screen can never appear without the access to
 * open it — or disappear while the access still exists.
 */
export function menuFor(user: ResolvedUser): MenuModule[] {
  const out: MenuModule[] = [];
  for (const mod of REGISTRY as ModuleDef[]) {
    const subs: MenuSubmodule[] = [];
    for (const sub of mod.submodules) {
      if (!canView(user, mod.key, sub.key)) continue;
      subs.push({
        key: sub.key,
        label: sub.label,
        path: sub.path,
        phase: sub.phase,
        note: sub.note,
        group: sub.group,
        hidden: sub.hidden,
        actions: sub.actions.filter((a) => can(user, `${mod.key}.${sub.key}.${a}`)),
      });
    }
    if (subs.length) out.push({ key: mod.key, label: mod.label, blurb: mod.blurb, submodules: subs });
  }
  return out;
}
