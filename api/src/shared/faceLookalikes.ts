import { Prisma } from '@prisma/client';
import { prisma } from '../prisma';

/**
 * HR's word that two faces are two people (2026-11-28, help ticket
 * GT-HT-2026-0046: Paul Iver Yumul's face read 0.487 from Mark Angelo
 * Ursulom's enrolled samples — under the 0.50 "same face" line — and HR
 * looked: different people). Enrolment refuses such a face as a collision
 * (`enrolCollision()` in shared/hr.ts); HR, having looked at the colleague's
 * samples, may let THIS person enrol beside THAT colleague for a week. The
 * enrolment then takes the sample as a look-alike — its audit row and Face
 * health name the pair — and the clock's margin rule tells the two apart at
 * every capture, both being enrolled.
 *
 * Never below `LOOKALIKE_FLOOR`: a face that close is the same face whatever
 * anybody says. One Setting row holds the permissions; nothing else writes it.
 */
export const LOOKALIKE_FLOOR = 0.4;
export const ALLOW_DAYS = 7;
const KEY = 'face.lookalikesAllowed';

export interface LookalikePermission {
  employeeId: string;
  otherId: string;
  otherName: string;
  byId: string;
  byName: string;
  at: string;
  until: string;
}

type Db = Prisma.TransactionClient | typeof prisma;

async function read(db: Db = prisma): Promise<LookalikePermission[]> {
  const row = await db.setting.findUnique({ where: { key: KEY } });
  const list = (row?.value as { entries?: LookalikePermission[] } | null)?.entries;
  return Array.isArray(list) ? list : [];
}

/** The unexpired permission for this person to enrol beside that colleague, if any. */
export async function lookalikeAllowed(employeeId: string, otherId: string, db: Db = prisma): Promise<LookalikePermission | null> {
  const now = Date.now();
  return (await read(db)).find((p) => p.employeeId === employeeId && p.otherId === otherId && Date.parse(p.until) > now) ?? null;
}

/** Every unexpired permission for this person. */
export async function lookalikesFor(employeeId: string): Promise<LookalikePermission[]> {
  const now = Date.now();
  return (await read()).filter((p) => p.employeeId === employeeId && Date.parse(p.until) > now);
}

/** Records HR's word for a week, replacing an earlier one for the same pair and dropping expired ones. */
export async function allowLookalike(input: { employeeId: string; otherId: string; otherName: string; byId: string; byName: string }): Promise<LookalikePermission> {
  const now = new Date();
  const entry: LookalikePermission = {
    ...input,
    at: now.toISOString(),
    until: new Date(now.getTime() + ALLOW_DAYS * 24 * 3600 * 1000).toISOString(),
  };
  const kept = (await read()).filter(
    (p) => Date.parse(p.until) > now.getTime() && !(p.employeeId === input.employeeId && p.otherId === input.otherId),
  );
  const value = { entries: [...kept, entry] } as unknown as Prisma.InputJsonValue;
  await prisma.setting.upsert({ where: { key: KEY }, create: { key: KEY, value }, update: { value } });
  return entry;
}

/**
 * The latest enrolment of this person refused as a collision in the last two
 * weeks — who it came near and how near — read off its audit row, for HR.
 */
export async function latestCollision(employeeId: string) {
  const since = new Date(Date.now() - 14 * 24 * 3600 * 1000);
  const rows = await prisma.auditLog.findMany({
    where: { entityType: 'employee', entityId: employeeId, action: 'REJECTED', at: { gte: since } },
    orderBy: { at: 'desc' },
    select: { at: true, after: true },
    take: 20,
  });
  for (const r of rows) {
    const after = r.after as { faceEnrolRefusal?: string; nearestOther?: { employeeId?: string; name?: string; distance?: number } | null } | null;
    const near = after?.nearestOther;
    if (after?.faceEnrolRefusal === 'collision' && near?.employeeId && typeof near.distance === 'number') {
      return { at: r.at, otherId: near.employeeId, otherName: near.name ?? 'another employee', distance: near.distance };
    }
  }
  return null;
}
