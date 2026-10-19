import { prisma } from '../prisma';
import { audit } from './audit';

export const OVERRIDES_DROPPED_MARK = 'seed.overridesDropped20261019';

/**
 * The per-person ALLOW / DENY overrides go (2026-10-19, the owner's call:
 * access is the role matrix alone — View Own / Team / All, Manage Own /
 * Team / All on Admin › Roles). Every override on file is removed ONCE, one
 * audit row per person naming what they had, so anybody who relied on one
 * can be given a role that grants it. `resolveUser()` no longer reads the
 * table, so a row left behind would do nothing; the table stays for history.
 */
export async function dropOverrides(): Promise<number | null> {
  if (await prisma.setting.findUnique({ where: { key: OVERRIDES_DROPPED_MARK } })) return null;
  const rows = await prisma.userPermissionOverride.findMany({
    select: { userId: true, effect: true, permission: { select: { key: true } }, user: { select: { name: true } } },
  });
  const byUser = new Map<string, { name: string; allow: string[]; deny: string[] }>();
  for (const r of rows) {
    const u = byUser.get(r.userId) ?? { name: r.user.name, allow: [], deny: [] };
    (r.effect === 'ALLOW' ? u.allow : u.deny).push(r.permission.key);
    byUser.set(r.userId, u);
  }
  await prisma.userPermissionOverride.deleteMany({});
  for (const [userId, u] of byUser) {
    await audit({
      entityType: 'user',
      entityId: userId,
      action: 'UPDATED',
      summary: `Per-person overrides removed (${u.allow.length} allow, ${u.deny.length} deny) — access is the role matrix alone now`,
      before: { allow: u.allow, deny: u.deny },
      after: null,
    });
  }
  await prisma.setting.create({
    data: {
      key: OVERRIDES_DROPPED_MARK,
      value: { at: new Date().toISOString(), people: byUser.size, rows: rows.length },
      description: 'seed: every per-person permission override removed once (2026-10-19, the role matrix replaces them)',
    },
  });
  return rows.length;
}
