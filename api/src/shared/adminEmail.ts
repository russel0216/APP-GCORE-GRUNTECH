import { prisma } from '../prisma';
import { audit } from './audit';

/**
 * The seeded super admin's sign-in address (2026-10-13, the owner's call:
 * "replace the admin email with gcore@gruntechnology.com"). A fresh database
 * makes its first super admin under it; an existing one moves to it once.
 */
export const ADMIN_EMAIL = 'gcore@gruntechnology.com';
/** The address the seed used before. */
export const OLD_ADMIN_EMAIL = 'admin@gruntech.com';

const MOVED_MARK = 'seed.adminEmailMoved';

export type AdminEmailMove =
  | { moved: true; from: string; to: string }
  | { moved: false; reason: 'done' | 'none' | 'taken'; to: string };

/**
 * Once, on the deploy that brings it: the super admin signing in as one of
 * `from` (the old seeded address, and whatever SEED_ADMIN_EMAIL named) signs
 * in as `to` from then on. Only the address changes — the same login, its
 * password, roles and history, and a session already open stays open (the
 * token names the user's id). Refused, and left for a person, when `to` is
 * already somebody's sign-in. Marked in a Setting, so an address changed
 * again by hand later is never undone; audited on the login.
 */
export async function moveAdminEmail(
  from: string[] = [OLD_ADMIN_EMAIL],
  to: string = ADMIN_EMAIL,
  mark: string = MOVED_MARK,
): Promise<AdminEmailMove> {
  const target = to.trim().toLowerCase();
  if (await prisma.setting.findUnique({ where: { key: mark } })) return { moved: false, reason: 'done', to: target };
  const sources = [...new Set(from.map((e) => e.trim().toLowerCase()))].filter((e) => e && e !== target);
  const admin = await prisma.user.findFirst({
    where: { email: { in: sources }, isSuperAdmin: true },
    orderBy: { createdAt: 'asc' },
    select: { id: true, email: true, name: true },
  });
  if (!admin) {
    // Nothing to move (a fresh install made the admin under the new address,
    // or the old one was changed already): the step is done.
    await prisma.setting.create({ data: { key: mark, value: { at: new Date().toISOString(), moved: false } } });
    return { moved: false, reason: 'none', to: target };
  }
  if (await prisma.user.findUnique({ where: { email: target }, select: { id: true } })) {
    // Not marked: once the other login is out of the way, the next deploy moves it.
    return { moved: false, reason: 'taken', to: target };
  }
  await prisma.$transaction(async (tx) => {
    await tx.user.update({ where: { id: admin.id }, data: { email: target } });
    await audit(
      {
        entityType: 'user',
        entityId: admin.id,
        action: 'UPDATED',
        summary: `Sign-in email changed from ${admin.email} to ${target} (the owner's call, 2026-10-13)`,
        actorName: 'System',
        before: { email: admin.email },
        after: { email: target },
      },
      undefined,
      tx,
    );
    await tx.setting.create({ data: { key: mark, value: { at: new Date().toISOString(), from: admin.email, to: target } } });
  });
  return { moved: true, from: admin.email, to: target };
}
