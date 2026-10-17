import { prisma } from '../../src/prisma';
import { signToken } from '../../src/auth/middleware';
import { env } from '../../src/env';
import { HOLIDAYS_KEY } from '../../src/shared/holidays';

/**
 * A verify script that counts working days must not depend on the holidays
 * the database holds (2026-10-17): its dates were chosen for a Mon–Sat week.
 * `holidaysAside()` stashes the stored list in `calendar.holidays.__verify__`
 * and empties it THROUGH THE API (`PUT /holidays`), so the running API drops
 * its cached copy at once; `holidaysBack()` — called by the script's
 * `cleanup()`, which also runs first — puts it back the same way. A run that
 * dies leaves the stash for the next run to restore.
 */
const STASH = `${HOLIDAYS_KEY}.__verify__`;
const BASE = `http://localhost:${env.port}/api`;

async function adminToken(): Promise<string | null> {
  const admin = await prisma.user.findFirst({ where: { isSuperAdmin: true, isActive: true }, select: { id: true, email: true } });
  return admin ? signToken(admin.id, admin.email) : null;
}

/** Puts a list through the API (the API reloads it); false when the API is not reachable. */
export async function putHolidays(list: unknown[]): Promise<boolean> {
  const token = await adminToken();
  if (!token) return false;
  try {
    const res = await fetch(`${BASE}/holidays`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ holidays: list }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export async function holidaysAside(): Promise<void> {
  const stash = await prisma.setting.findUnique({ where: { key: STASH } });
  if (!stash) {
    const live = await prisma.setting.findUnique({ where: { key: HOLIDAYS_KEY } });
    await prisma.setting.create({ data: { key: STASH, value: { list: (live?.value as unknown[] | undefined) ?? null } } });
  }
  if (!(await putHolidays([]))) {
    await prisma.setting.upsert({ where: { key: HOLIDAYS_KEY }, create: { key: HOLIDAYS_KEY, value: [] }, update: { value: [] } });
  }
}

export async function holidaysBack(): Promise<void> {
  const stash = await prisma.setting.findUnique({ where: { key: STASH } });
  if (!stash) return;
  const list = (stash.value as { list: unknown[] | null }).list;
  if (!(await putHolidays(list ?? []))) {
    if (list === null) await prisma.setting.deleteMany({ where: { key: HOLIDAYS_KEY } });
    else await prisma.setting.upsert({ where: { key: HOLIDAYS_KEY }, create: { key: HOLIDAYS_KEY, value: list as never }, update: { value: list as never } });
  }
  await prisma.setting.delete({ where: { key: STASH } });
}
