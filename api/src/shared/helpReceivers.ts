import { Prisma } from '@prisma/client';
import { prisma } from '../prisma';

/**
 * Who receives the Help box's tickets (2026-10-11, the owner's call: "allow
 * me to assign who receive the help ticket").
 *
 * One Setting, `helpTickets.receivers` = `{ userIds }`, chosen by a super
 * admin on Admin › Help Tickets. The people on it are told of every new
 * ticket and hold the screen's two rights — reading every ticket and
 * answering them — whatever their roles: `resolveUser()` adds
 * `RECEIVER_RIGHTS` for them (a per-user DENY still wins), so the menu, the
 * page's Guard and the routes agree without anybody editing a role. Nobody
 * chosen means every active super admin, as before.
 *
 * `resolveUser` runs on every request, so the list is cached for a minute in
 * this process and dropped the moment it is saved here.
 */

export const HELP_RECEIVERS_KEY = 'helpTickets.receivers';
export const RECEIVER_RIGHTS = ['admin.help_tickets.view_all', 'admin.help_tickets.edit_all'] as const;
/** The most people one list holds — a list of everybody is not a choice. */
export const MAX_RECEIVERS = 50;

const FRESH_MS = 60_000;
let cache: { at: number; ids: Set<string> } | null = null;

/** The chosen people's ids as stored — active or not; empty when nobody is chosen. */
export async function chosenReceiverIds(tx: Prisma.TransactionClient = prisma): Promise<string[]> {
  const row = await tx.setting.findUnique({ where: { key: HELP_RECEIVERS_KEY } });
  const value = row?.value as { userIds?: unknown } | null | undefined;
  return Array.isArray(value?.userIds) ? value.userIds.filter((v): v is string => typeof v === 'string') : [];
}

/** Whether this login is on the chosen list (cached a minute). */
export async function isChosenReceiver(userId: string): Promise<boolean> {
  if (!cache || Date.now() - cache.at > FRESH_MS) cache = { at: Date.now(), ids: new Set(await chosenReceiverIds()) };
  return cache.ids.has(userId);
}

/** Stores the list (deduplicated, in the order given) and drops the cache. */
export async function saveReceivers(userIds: string[], tx: Prisma.TransactionClient = prisma): Promise<void> {
  const ids = [...new Set(userIds)];
  await tx.setting.upsert({
    where: { key: HELP_RECEIVERS_KEY },
    create: { key: HELP_RECEIVERS_KEY, value: { userIds: ids }, description: 'Who receives the Help box’s tickets (Admin › Help Tickets)' },
    update: { value: { userIds: ids } },
  });
  cache = null;
}

/** Drops the cached list — after a save, or when a script changes the Setting itself. */
export function forgetReceivers(): void {
  cache = null;
}

/**
 * Who is told of a new ticket: the chosen people who are still active, else
 * every active super admin — never nobody while a super admin exists.
 */
export async function ticketReceivers(): Promise<string[]> {
  const chosen = await chosenReceiverIds();
  if (chosen.length) {
    const active = await prisma.user.findMany({ where: { id: { in: chosen }, isActive: true }, select: { id: true } });
    if (active.length) return active.map((u) => u.id);
  }
  const admins = await prisma.user.findMany({ where: { isSuperAdmin: true, isActive: true }, select: { id: true } });
  return admins.map((u) => u.id);
}
