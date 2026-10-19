import type { Prisma } from '@prisma/client';
import { prisma } from '../prisma';

/**
 * A team's management posts (2026-10-19, the owner's call: "KAT's Technical
 * Manager and Aftermarket Manager are shared with GIB, UIT and HIT's; later
 * prepare the setting if someone is hired to that role"). One `TeamPost` row
 * per team and post, edited on Admin › Categories › Teams:
 *
 * - OWN (or no row): the holders of the role on the team — the engine's own
 *   team rule, as before;
 * - SHARED: the holders of the role on the teams named;
 * - PEOPLE: the logins named.
 *
 * `teamPostHolders()` is the one reading, asked by the approval engine before
 * its own team rule; null means "OWN — keep the usual rule".
 */
export const TEAM_POST_ROLES: { key: string; label: string }[] = [
  { key: 'team_leader', label: 'Team Leader' },
  { key: 'technical_manager', label: 'Technical Manager' },
  { key: 'sales_manager', label: 'Sales Manager' },
  { key: 'service_manager', label: 'Aftermarket Manager' },
];
export const TEAM_POST_KEYS = TEAM_POST_ROLES.map((r) => r.key);

/** KAT's posts start shared with GIB, UIT and HIT (the seed, once). */
export const SHARED_POST_SEED = { team: 'KAT', roles: ['technical_manager', 'service_manager'], from: ['GIB', 'UIT', 'HIT'] };
export const TEAM_POSTS_MARK = 'seed.teamPosts20261019';

/**
 * Who holds `roleKey` for `teamId` when the team's post says otherwise than
 * OWN — active logins, never the requester — else null. An empty answer
 * (nobody on the shared teams yet) is null too, so a document never stalls.
 */
export async function teamPostHolders(
  roleKey: string,
  teamId: string | null | undefined,
  requesterId: string,
  tx: Prisma.TransactionClient = prisma,
): Promise<string[] | null> {
  if (!teamId || !TEAM_POST_KEYS.includes(roleKey)) return null;
  const post = await tx.teamPost.findUnique({ where: { teamId_roleKey: { teamId, roleKey } } });
  if (!post || post.mode === 'OWN') return null;
  let ids: string[] = [];
  if (post.mode === 'PEOPLE') {
    const users = await tx.user.findMany({ where: { id: { in: post.userIds }, isActive: true }, select: { id: true } });
    ids = users.map((u) => u.id);
  } else if (post.sharedTeamIds.length) {
    const rows = await tx.userRole.findMany({
      where: { role: { key: roleKey }, user: { isActive: true, employee: { industryId: { in: post.sharedTeamIds } } } },
      select: { userId: true },
    });
    ids = [...new Set(rows.map((r) => r.userId))];
  }
  ids = ids.filter((id) => id !== requesterId);
  return ids.length ? ids : null;
}

/** The requester's team (`Employee.industryId`). */
export async function teamOfRequester(requesterId: string, tx: Prisma.TransactionClient = prisma): Promise<string | null> {
  const e = await tx.employee.findUnique({ where: { userId: requesterId }, select: { industryId: true } });
  return e?.industryId ?? null;
}

/** Once: KAT's Technical Manager and Aftermarket Manager shared with GIB, UIT and HIT. */
export async function seedSharedPosts(): Promise<number | null> {
  if (await prisma.setting.findUnique({ where: { key: TEAM_POSTS_MARK } })) return null;
  const teams = await prisma.industry.findMany({ where: { code: { in: [SHARED_POST_SEED.team, ...SHARED_POST_SEED.from] } }, select: { id: true, code: true } });
  const team = teams.find((t) => t.code === SHARED_POST_SEED.team);
  const from = teams.filter((t) => SHARED_POST_SEED.from.includes(t.code)).map((t) => t.id);
  let made = 0;
  if (team && from.length) {
    for (const roleKey of SHARED_POST_SEED.roles) {
      await prisma.teamPost.upsert({
        where: { teamId_roleKey: { teamId: team.id, roleKey } },
        create: { teamId: team.id, roleKey, mode: 'SHARED', sharedTeamIds: from },
        update: {},
      });
      made += 1;
    }
  }
  await prisma.setting.create({
    data: { key: TEAM_POSTS_MARK, value: { at: new Date().toISOString(), made }, description: "seed: KAT's Technical Manager and Aftermarket Manager shared with GIB, UIT and HIT, once (2026-10-19)" },
  });
  return made;
}
