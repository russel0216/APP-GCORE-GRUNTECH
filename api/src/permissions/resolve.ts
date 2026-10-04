import { prisma } from '../prisma';
import { REGISTRY, type ModuleDef } from './registry';

export interface ResolvedUser {
  id: string;
  email: string;
  name: string;
  position: string | null;
  isSuperAdmin: boolean;
  supervisorId: string | null;
  departmentId: string | null;
  roleKeys: string[];
  /** Effective permission keys after roles + per-user overrides. */
  permissions: Set<string>;
}

/**
 * Effective permissions = union of role permissions, plus per-user ALLOW,
 * minus per-user DENY.
 *
 * DENY wins over everything except super admin. That ordering matters: it lets
 * you hand someone a broad role and then close one door, which is how access is
 * actually administered in practice.
 */
export async function resolveUser(userId: string): Promise<ResolvedUser | null> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: {
      roles: { include: { role: { include: { permissions: { include: { permission: true } } } } } },
      overrides: { include: { permission: true } },
    },
  });
  if (!user || !user.isActive) return null;

  const granted = new Set<string>();
  for (const ur of user.roles) {
    for (const rp of ur.role.permissions) granted.add(rp.permission.key);
  }
  for (const o of user.overrides) {
    if (o.effect === 'ALLOW') granted.add(o.permission.key);
  }
  for (const o of user.overrides) {
    if (o.effect === 'DENY') granted.delete(o.permission.key);
  }

  return {
    id: user.id,
    email: user.email,
    name: user.name,
    position: user.position,
    isSuperAdmin: user.isSuperAdmin,
    supervisorId: user.supervisorId,
    departmentId: user.departmentId,
    roleKeys: user.roles.map((r) => r.role.key),
    permissions: granted,
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
