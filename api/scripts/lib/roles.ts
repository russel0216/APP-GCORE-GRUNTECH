/**
 * A seeded role for a test user — the ONE way the verify scripts give one
 * (2026-10-18). Every role on an install was emptied that day for the owner
 * to build his own (shared/rolesClear.ts), so a role the seed once filled
 * may hold anything or nothing: a script that put a user on the seeded `hr`
 * role and expected HR's screens to open leaned on what the install's roles
 * hold, which is the operator's business.
 *
 * `rolesLike(prefix, keys)` answers, for each key, TWO roles: the real one
 * (the engine reads `hr`, `team_leader`, `ceo` … by KEY, so the user must
 * hold it to be routed to — made, empty, if the install no longer has it)
 * and a throwaway `<prefix>like_<key>` carrying the rights the seed's
 * definition gives that key (`roleSeedPermissionKeys`), refilled on every
 * call. The prefix is the one the script's `cleanup()` deletes by.
 */
import { prisma } from '../../src/prisma';
import { ROLE_SEEDS, roleSeedPermissionKeys } from '../../src/shared/roleSeeds';

export async function rolesLike(prefix: string, keys: string[]): Promise<{ id: string; key: string }[]> {
  const out: { id: string; key: string }[] = [];
  for (const key of keys) {
    const seed = ROLE_SEEDS.find((r) => r.key === key);
    if (!seed) {
      // A role the script made itself: as it is.
      const own = await prisma.role.findUnique({ where: { key }, select: { id: true, key: true } });
      if (!own) throw new Error(`No role "${key}" — neither seeded nor made by this script`);
      out.push(own);
      continue;
    }
    const real = await prisma.role.upsert({
      where: { key },
      create: { key, name: seed.name, description: seed.description, isSystem: false },
      update: {},
      select: { id: true, key: true },
    });
    out.push(real);
    const wanted = roleSeedPermissionKeys(key);
    const permissions = await prisma.permission.findMany({ where: { key: { in: wanted } }, select: { id: true } });
    const likeKey = `${prefix}like_${key}`;
    const like = await prisma.role.upsert({
      where: { key: likeKey },
      create: { key: likeKey, name: `${prefix} like ${seed.name}`, description: `The seed's ${key} rights, for a verify script`, isSystem: false },
      update: {},
      select: { id: true, key: true },
    });
    await prisma.rolePermission.deleteMany({ where: { roleId: like.id } });
    if (permissions.length) {
      await prisma.rolePermission.createMany({ data: permissions.map((p) => ({ roleId: like.id, permissionId: p.id })), skipDuplicates: true });
    }
    out.push(like);
  }
  return out;
}
